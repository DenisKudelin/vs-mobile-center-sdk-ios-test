import { SDKIntegrationStepBase, SDKIntegrationError } from "./SDKIntegrationStepBase";
import * as Promise from "bluebird";
import * as Path from "path";
import * as Helpers from "../Helpers/Helpers";
import * as FS from "fs";
import * as Globule from "globule";
import { ncp } from "ncp";
import { TextWalkerC, TextWalkerCBag } from "../TextWalker/text-walker-c";
const Xcode = require("xcode");

export function runXcodeSDKIntegration(projectPath: string, applicationToken: string, sdkModules: MobileCenterSDKModule): Promise<void> {
    if (!sdkModules) {
        return Promise.reject(new SDKIntegrationError("At least one of SDK modules should be specified"));
    }

    const context: ISDKIntegrationStepContext = { projectPath: projectPath, applicationToken: applicationToken, sdkModules: sdkModules, actions: [] };
    return new SearchProjectPaths().run(context).then(() => {
        return context.actions.reduce((previous, current) => Promise.try(previous).then(current) as any) as any;
    });
}

export enum MobileCenterSDKModule {
    Analytics = 1,
    Crashes = 2,
    Distribute = 4,
}

interface ISDKIntegrationStepContext {
    projectPath: string;
    projectRootDirectory?: string;
    appDelegateFile?: string;
    sdkModules: MobileCenterSDKModule;
    actions: (() => void | Promise<void>)[];
    applicationToken: string;
    projectName?: string;
}

abstract class SDKIntegrationStep extends SDKIntegrationStepBase<ISDKIntegrationStepContext>{
    protected sdkDirectoryName = "Vendor";
    protected get analyticsEnabled() {
        return (this.context.sdkModules & MobileCenterSDKModule.Analytics) === MobileCenterSDKModule.Analytics;
    }
    protected get crashesEnabled() {
        return (this.context.sdkModules & MobileCenterSDKModule.Crashes) === MobileCenterSDKModule.Crashes;
    }
    protected get distributeEnabled() {
        return (this.context.sdkModules & MobileCenterSDKModule.Distribute) === MobileCenterSDKModule.Distribute;
    }
}

class SearchProjectPaths extends SDKIntegrationStep {
    protected nextStep = new AddCocoapodsDependencies();
    protected step() {
        const xcodeProjectDirectory = this.findXcodeProjectDirectory();
        this.context.projectRootDirectory = Path.join(xcodeProjectDirectory, "../");
        this.context.projectName = Path.basename(xcodeProjectDirectory, Path.extname(xcodeProjectDirectory));
    }

    private findXcodeProjectDirectory() {
        const xcworkspacedataFiles = Globule.find(["**/*.xcworkspace/*.xcworkspacedata", "!**/*.xcodeproj/**"], { srcBase: this.context.projectPath, prefixBase: true });
        const pbxprojFiles = Globule.find(["**/*.xcodeproj/*.pbxproj", "!**/Pods.xcodeproj/*.pbxproj"], { srcBase: this.context.projectPath, prefixBase: true });
        const files = xcworkspacedataFiles.concat(pbxprojFiles).sort((a, b) => a.split("/").length - b.split("/").length);
        if (!files.length) {
            throw new SDKIntegrationError("There are no projects");
        }

        return Path.join(files[0], "../");
    }
}

class AddCocoapodsDependencies extends SDKIntegrationStep {
    protected nextStep = new SearchAppDelegateFile();
    protected step() {
        const podfile = Path.join(this.context.projectRootDirectory, "Podfile");

        let content = this.getContent(podfile);
        content = this.addOrRemoveService(content, "pod 'MobileCenter/MobileCenterAnalytics'", this.analyticsEnabled);
        content = this.addOrRemoveService(content, "pod 'MobileCenter/MobileCenterCrashes'", this.crashesEnabled);
        content = this.addOrRemoveService(content, "pod 'MobileCenter/MobileCenterDistribute'", this.distributeEnabled);
        this.context.actions.push(() => FS.writeFileSync(podfile, content, { encoding: "utf8" }));
    }

    private getContent(podFile: string): string {
        if (!FS.existsSync(podFile)) {
            return `platform :ios, '8.0'`;
        } else {
            return FS.readFileSync(podFile, "utf8");
        }
    }

    private addOrRemoveService(content: string, service: string, add: boolean) {
        let match: RegExpExecArray;
        const targetRegExp = new RegExp(`(target\\s+?:?['"]?${Helpers.escapeRegExp(this.context.projectName)}['"]?\\s+?do[\\s\\S]*?\r?\n)end`, "i");
        match = targetRegExp.exec(content);
        let startIndex: number;
        let endIndex: number;
        if (match) {
            startIndex = match.index;
            endIndex = match.index + match[1].length;
        } else {
            startIndex = content.length;
            content += `\ntarget '${this.context.projectName}' do\n  use_frameworks!\n`;
            endIndex = content.length;
            content += "end";
        }

        let serviceIndex = -1;
        const serviceRegex = new RegExp(` *?${service}\r?\n?`);
        match = serviceRegex.exec(content.substr(startIndex, endIndex - startIndex));
        if (match) {
            serviceIndex = startIndex + match.index;
        }

        if (!add) {
            return (~serviceIndex) ? Helpers.splice(content, serviceIndex, match[0].length, "") : content;
        }

        return serviceIndex >= 0 ? content : Helpers.splice(content, endIndex, 0, `  ${service}\n`);
    }
}

class SearchAppDelegateFile extends SDKIntegrationStep {
    protected step() {
        return this.searchSwiftAppDelegate()
            .then(path => path || this.searchObjectiveCAppDelegate())
            .then((path: string) => {
                if (!path) {
                    throw new SDKIntegrationError("There is no AppDelegate file");
                } else {
                    this.context.appDelegateFile = path;
                }

                if (Helpers.endsWith(this.context.appDelegateFile, ".swift")) {
                    this.nextStep = new InsertSDKInAppDelegateSwift();
                } else {
                    this.nextStep = new InsertSDKInAppDelegateObjectiveC();
                }
            });
    }

    private searchInFiles(ext: string, isAppDelegateFile: (path: string) => Promise<boolean>): Promise<string> {
        return Promise.try<string>(() => {
            const files = Globule.find("**/*." + ext, { srcBase: this.context.projectRootDirectory, prefixBase: true });
            const cycle = (index: number) => {
                if (index >= files.length) {
                    return null;
                }

                return isAppDelegateFile(files[index]).then(value => value ? files[index] : cycle(index + 1));
            };
            return cycle(0);
        });
    }

    private searchSwiftAppDelegate() {
        return this.searchInFiles("swift", path => this.isSwiftAppDelegateFile(path));
    }

    private isSwiftAppDelegateFile(path: string): Promise<boolean> {
        return Promise.try<boolean>(() => {
            const content = FS.readFileSync(path, "utf8");
            return /@UIApplicationMain[\s\w@]+?class\s+?[\w]+\s*?:/.test(content);
        });
    }

    private searchObjectiveCAppDelegate() {
        let implementationName: string;
        return this.searchInFiles("h", path => Promise.try<boolean>(() => {
            const content = FS.readFileSync(path, "utf8");
            const match = /@interface\s+?(\w+)\s*?:\s*?(NSObject|UIResponder)\s*\<\s*?UIApplicationDelegate/.exec(content);
            if (match) {
                implementationName = match[1];
                return true;
            } else {
                return false;
            }
        })).then(path => {
            if (!path) {
                return null;
            }

            const srcPath = Path.join(path, "../", Path.basename(path, Path.extname(path))) + ".m";
            return this.isObjectiveCAppDelegateFile(srcPath, implementationName).then(value => {
                if (value) {
                    return srcPath;
                } else {
                    return this.searchInFiles("h", path => this.isObjectiveCAppDelegateFile(path, implementationName));
                }
            });
        });
    }

    private isObjectiveCAppDelegateFile(path: string, implementationName: string): Promise<boolean> {
        return Promise.try<boolean>(() => {
            const content = FS.readFileSync(path, "utf8");
            return new RegExp(`\\s+@implementation ${implementationName}\\s+`).test(content);
        });
    }
}

class InsertSDKInAppDelegateSwift extends SDKIntegrationStep {
    protected step() {
        let appDelegateContent = FS.readFileSync(this.context.appDelegateFile, "utf8");
        const bag = this.analyze(appDelegateContent);

        // Need to keep this insertion order to avoid index shifting.
        appDelegateContent = this.insertStart(bag, appDelegateContent);
        appDelegateContent = this.insertImports(bag, appDelegateContent);
        this.context.actions.push(() => FS.writeFileSync(this.context.appDelegateFile, appDelegateContent, { encoding: "utf8" }));
    }

    private analyze(appDelegateContent: string): TextWalkerSwiftInjectBag {
        const textWalker = new TextWalkerC(appDelegateContent, new TextWalkerSwiftInjectBag());
        textWalker.addTrap(bag => bag.significant
            && bag.blockLevel === 0
            && !bag.wasWithinClass
            && /import\s+?[\w\.]+?\r?\n$/.test(textWalker.backpart),
            bag => {
                bag.endOfImportBlockIndex = textWalker.position;
            });
        textWalker.addTrap(bag =>
            bag.significant
            && bag.blockLevel === 1
            && textWalker.currentChar === "{",
            bag => {
                const matches = /\s*([a-z]+?\s+?|)(class|extension)\s+?\w+?(?!\w).*?$/.exec(textWalker.backpart);
                if (matches && matches[0]) {
                    bag.isWithinClass = true;
                    bag.wasWithinClass = true;
                }
            });
        textWalker.addTrap(
            bag =>
                bag.significant &&
                bag.blockLevel === 0 &&
                bag.isWithinClass &&
                textWalker.currentChar === "}",
            bag => bag.isWithinClass = false
        );
        textWalker.addTrap(
            bag =>
                bag.significant &&
                bag.isWithinClass &&
                bag.blockLevel === 2 &&
                textWalker.currentChar === '{',
            bag => {
                const matches = /^\s*([a-z]+?\s+?|)func\s+?application\s*?\(/m.exec(textWalker.backpart)
                if (matches && bag.applicationFuncStartIndex < 0) {
                    bag.isWithinMethod = true;
                    bag.applicationFuncStartIndex = textWalker.position + 1;
                    bag.isWithinApplicationMethod = true;
                }
            }
        );
        textWalker.addTrap(
            bag =>
                bag.significant &&
                bag.blockLevel === 1 &&
                bag.isWithinMethod &&
                textWalker.currentChar === "}",
            bag => {
                bag.isWithinMethod = false;
                if (bag.isWithinApplicationMethod) {
                    bag.applicationFuncEndIndex = textWalker.position;
                    bag.isWithinApplicationMethod = false;
                }
            }
        );
        textWalker.addTrap(
            bag => bag.significant
                && bag.isWithinApplicationMethod
                && bag.msMobileCenterStartCallStartIndex < 0
                && Helpers.startsWith(textWalker.forepart, "MSMobileCenter.start"),
            bag => {
                let match = /^MSMobileCenter.start\s*?\(".+?",\s*?withServices: .+?\)/.exec(textWalker.forepart);
                if (match) {
                    bag.msMobileCenterStartCallStartIndex = textWalker.position;
                    bag.msMobileCenterStartCallLength = match[0].length;
                    match = /(\r?\n|) *?$/.exec(textWalker.backpart);
                    if (match) {
                        bag.msMobileCenterStartCallStartIndex -= match[0].length;
                        bag.msMobileCenterStartCallLength += match[0].length;
                    }
                }
            });
        return textWalker.walk();
    }

    private insertImports(bag: TextWalkerSwiftInjectBag, appDelegateContent: string): string {
        if (bag.endOfImportBlockIndex < 0) {
            bag.endOfImportBlockIndex = 0;
        }

        appDelegateContent = this.addOrRemoveImport(appDelegateContent, bag.endOfImportBlockIndex, "MobileCenter", true);
        appDelegateContent = this.addOrRemoveImport(appDelegateContent, bag.endOfImportBlockIndex, "MobileCenterAnalytics", this.analyticsEnabled);
        appDelegateContent = this.addOrRemoveImport(appDelegateContent, bag.endOfImportBlockIndex, "MobileCenterCrashes", this.crashesEnabled);
        appDelegateContent = this.addOrRemoveImport(appDelegateContent, bag.endOfImportBlockIndex, "MobileCenterDistribute", this.distributeEnabled);

        return appDelegateContent;
    }

    private addOrRemoveImport(appDelegateContent: string, index: number, item: string, add: boolean) {
        const match = new RegExp(`import +${item}\r?\n`).exec(appDelegateContent.substr(0, index));
        if (match && !add) {
            return Helpers.splice(appDelegateContent, match.index, match[0].length, "");
        } else if (!match && add) {
            return Helpers.splice(appDelegateContent, index, 0, `import ${item}\n`);
        } else {
            return appDelegateContent;
        }
    }

    private insertStart(bag: TextWalkerSwiftInjectBag, appDelegateContent: string): string {
        if (bag.applicationFuncStartIndex < 0) {
            throw new SDKIntegrationError("Function 'application' is not defined in AppDelegate");
        }

        if (bag.msMobileCenterStartCallStartIndex >= 0) {
            appDelegateContent = Helpers.splice(appDelegateContent, bag.msMobileCenterStartCallStartIndex, bag.msMobileCenterStartCallLength, "");
        }

        const services: string[] = [];
        if (this.analyticsEnabled) {
            services.push("MSAnalytics.self");
        }

        if (this.crashesEnabled) {
            services.push("MSCrashes.self");
        }

        if (this.distributeEnabled) {
            services.push("MSDistribute.self");
        }

        const start = `MSMobileCenter.start("${this.context.applicationToken}", withServices: [${services.join(", ")}])`;
        appDelegateContent = Helpers.splice(appDelegateContent, bag.applicationFuncStartIndex, 0, `\n        ${start}`);
        return appDelegateContent;
    }
}

class TextWalkerSwiftInjectBag extends TextWalkerCBag {
    isWithinClass: boolean = false;
    wasWithinClass: boolean = false;
    isWithinMethod: boolean = false;
    isWithinApplicationMethod: boolean = false;
    applicationFuncStartIndex: number = -1;
    endOfImportBlockIndex: number = -1;
    applicationFuncEndIndex: number = -1;
    msMobileCenterStartCallStartIndex: number = -1;
    msMobileCenterStartCallLength: number = -1;
}

class InsertSDKInAppDelegateObjectiveC extends SDKIntegrationStep {
    protected step() {
        let appDelegateContent = FS.readFileSync(this.context.appDelegateFile, "utf8");
        const bag = this.analyze(appDelegateContent);

        // Need to keep this insertion order to avoid index shifting.
        appDelegateContent = this.insertStart(bag, appDelegateContent);
        appDelegateContent = this.insertImports(bag, appDelegateContent);
        this.context.actions.push(() => FS.writeFileSync(this.context.appDelegateFile, appDelegateContent, { encoding: "utf8" }));
    }

    private analyze(appDelegateContent: string): TextWalkerObjectiveCInjectBag {
        const textWalker = new TextWalkerC(appDelegateContent, new TextWalkerObjectiveCInjectBag());
        textWalker.addTrap(bag => bag.significant
            && bag.blockLevel === 0
            && !bag.isWithinImplementation
            && /[@#]import\s+?[\w"<>\/\.]+?;?\r?\n$/.test(textWalker.backpart),
            bag => {
                bag.endOfImportBlockIndex = textWalker.position;
            });
        textWalker.addTrap(bag =>
            bag.significant
            && bag.blockLevel === 0
            && Helpers.startsWith(textWalker.forepart, "@implementation"),
            bag => {
                const matches = /^@implementation\s+?\w+?\r?\n/.exec(textWalker.forepart);
                if (matches && matches[0]) {
                    bag.isWithinImplementation = true;
                    bag.wasWithinImplementation = true;
                }
            });
        textWalker.addTrap(
            bag =>
                bag.significant
                && bag.blockLevel === 0
                && bag.isWithinImplementation
                && textWalker.currentChar === "@"
                && Helpers.startsWith(textWalker.forepart, "@end"),
            bag => bag.isWithinImplementation = false
        );
        textWalker.addTrap(
            bag =>
                bag.significant
                && bag.isWithinImplementation
                && bag.blockLevel === 1
                && bag.applicationFuncStartIndex < 0
                && textWalker.currentChar === '{',
            bag => {
                const matches = /-\s*?\(\s*?[\w\.]+?\s*?\)\s*application(?!\w)[\s\S]*?$/.exec(textWalker.backpart);
                if (matches) {
                    bag.applicationFuncStartIndex = textWalker.position + 1;
                    bag.isWithinApplicationMethod = true;
                }
            }
        );
        textWalker.addTrap(
            bag =>
                bag.significant
                && bag.blockLevel === 0
                && bag.isWithinApplicationMethod
                && textWalker.currentChar === "}",
            bag => {
                bag.applicationFuncEndIndex = textWalker.position;
                bag.isWithinApplicationMethod = false;
            }
        );
        textWalker.addTrap(
            bag => bag.significant
                && bag.isWithinApplicationMethod
                && bag.msMobileCenterStartCallStartIndex < 0
                && /^\[\s*?MSMobileCenter\s+?start/.test(textWalker.forepart),
            bag => {
                let match = /^\[\s*?MSMobileCenter\s+?start\s*?:[\s\S]+?withServices[\s\S]+?\]\s*\]\s*?;/.exec(textWalker.forepart);
                if (match) {
                    bag.msMobileCenterStartCallStartIndex = textWalker.position;
                    bag.msMobileCenterStartCallLength = match[0].length;
                    match = /(\r?\n|) *?$/.exec(textWalker.backpart);
                    if (match) {
                        bag.msMobileCenterStartCallStartIndex -= match[0].length;
                        bag.msMobileCenterStartCallLength += match[0].length;
                    }
                }
            });
        return textWalker.walk();
    }

    private insertImports(bag: TextWalkerObjectiveCInjectBag, appDelegateContent: string): string {
        if (bag.endOfImportBlockIndex < 0) {
            bag.endOfImportBlockIndex = 0;
        }

        appDelegateContent = this.addOrRemoveImport(appDelegateContent, bag.endOfImportBlockIndex, "MobileCenter", true);
        appDelegateContent = this.addOrRemoveImport(appDelegateContent, bag.endOfImportBlockIndex, "MobileCenterAnalytics", this.analyticsEnabled);
        appDelegateContent = this.addOrRemoveImport(appDelegateContent, bag.endOfImportBlockIndex, "MobileCenterCrashes", this.crashesEnabled);
        appDelegateContent = this.addOrRemoveImport(appDelegateContent, bag.endOfImportBlockIndex, "MobileCenterDistribute", this.distributeEnabled);

        return appDelegateContent;
    }

    private addOrRemoveImport(appDelegateContent: string, index: number, item: string, add) {
        const match = new RegExp(`@import +${item} *?;\r?\n`).exec(appDelegateContent.substr(0, index));
        if (match && !add) {
            return Helpers.splice(appDelegateContent, match.index, match[0].length, "");
        } else if (!match && add) {
            return Helpers.splice(appDelegateContent, index, 0, `@import ${item};\n`);
        } else {
            return appDelegateContent;
        }
    }

    private insertStart(bag: TextWalkerObjectiveCInjectBag, appDelegateContent: string): string {
        if (bag.applicationFuncStartIndex < 0) {
            throw new SDKIntegrationError("Function 'application' is not defined in AppDelegate");
        }

        if (bag.msMobileCenterStartCallStartIndex >= 0) {
            appDelegateContent = Helpers.splice(appDelegateContent, bag.msMobileCenterStartCallStartIndex, bag.msMobileCenterStartCallLength, "");
        }

        const services: string[] = [];
        if (this.analyticsEnabled) {
            services.push("[MSAnalytics class]")
        }

        if (this.crashesEnabled) {
            services.push("[MSCrashes class]")
        }

        if (this.distributeEnabled) {
            services.push("[MSDistribute class]");
        }

        const start = `[MSMobileCenter start:@"${this.context.applicationToken}" withServices:@[${services.join(", ")}]];`
        appDelegateContent = Helpers.splice(appDelegateContent, bag.applicationFuncStartIndex, 0, `\n    ${start}`);
        return appDelegateContent;
    }
}

class TextWalkerObjectiveCInjectBag extends TextWalkerCBag {
    isWithinImplementation: boolean = false;
    wasWithinImplementation: boolean = false;
    endOfImportBlockIndex: number = -1;
    applicationFuncStartIndex: number = -1;
    isWithinApplicationMethod: boolean = false;
    applicationFuncEndIndex: number = -1;
    msMobileCenterStartCallStartIndex: number = -1;
    msMobileCenterStartCallLength: number = -1;
}
