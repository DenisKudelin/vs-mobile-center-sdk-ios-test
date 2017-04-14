import { SDKIntegrationStepBase } from "./SDKIntegrationStepBase";
import { VCSRepository } from "../VCSRepository/VCSRepository";
import * as Promise from "bluebird";
import * as Path from "path";
import * as Helpers from "../Helpers/Helpers";
import * as FS from "fs";
import { ncp } from "ncp";
import { TextWalkerC, TextWalkerCBag } from "../TextWalker/text-walker-c";
const Xcode = require("xcode");

export function runXcodeSDKIntegration(projectPath: string, applicationToken: string, sdkParts: MobileCenterSDKModule) {
    const repository = new VCSRepository(projectPath);
    const context: ISDKIntegrationStepContext = { repository: repository, applicationToken: applicationToken, sdkParts: sdkParts, actions: [] };
    return new FindProjectPaths().run(context).then(() => {
        return context.actions.reduce((previous, current) => Promise.try(previous).then(current) as any);
    });
}

export enum MobileCenterSDKModule {
    Analytics = 1,
    Crashes = 2,
    Distribute = 4,
}

interface ISDKIntegrationStepContext {
    repository: VCSRepository;
    sdkParts: MobileCenterSDKModule;
    actions: (() => void | Promise<void>)[];
    projectFile?: IVCSRepositoryFileEntry;
    appDelegateFile?: IVCSRepositoryFileEntry;
    projectName?: string;
    projectRootDirectory?: IVCSRepositoryDirectoryEntry;
    projectFilesDirectory?: IVCSRepositoryDirectoryEntry;
    sdkVendorDirectories?: IVCSRepositoryDirectoryEntry[];
    applicationToken: string;
}

abstract class SDKIntegrationStep extends SDKIntegrationStepBase<ISDKIntegrationStepContext>{
    protected sdkDirectoryName = "Vendor";
    protected callIfSdkPartEnabled(analyticsEnabled: () => void, crashesEnabled: () => void, distributeEnabled: () => void) {
        if ((this.context.sdkParts & MobileCenterSDKModule.Analytics) === MobileCenterSDKModule.Analytics) {
            analyticsEnabled();
        }

        if ((this.context.sdkParts & MobileCenterSDKModule.Crashes) === MobileCenterSDKModule.Crashes) {
            crashesEnabled();
        }

        if ((this.context.sdkParts & MobileCenterSDKModule.Distribute) === MobileCenterSDKModule.Distribute) {
            distributeEnabled();
        }
    }
}

class FindProjectPaths extends SDKIntegrationStep {
    protected nextStep = new AddCocoapodsDependencies();
    protected step() {
        return this.context.repository.walkTree((entry: IVCSRepositoryEntry) => {
            if (!entry.isDirectory && Helpers.endsWith(entry.name, ".pbxproj")) {
                return entry;
            }
        }).then((value: IVCSRepositoryFileEntry) => {
            if (!value) {
                return Promise.reject(`There is no *.pbxproj file`);
            }

            const dirName = Path.dirname(value.path);
            if (!Helpers.endsWith(dirName, ".xcodeproj"))
                return Promise.reject(`The *.pbxproj is in a incorrect folder`);

            this.context.projectFile = value;
            this.context.projectName = /\\([^\\/]+?)\.xcodeproj/.exec(dirName)[1];
            this.context.projectRootDirectory = this.context.repository.getEntryByPath(Path.join(this.context.projectFile.path, "..\\..\\") + "\\") as IVCSRepositoryDirectoryEntry;

            return this.context.projectRootDirectory.getDirectoryEntries().then(directories => {
                this.context.projectFilesDirectory = directories.filter(x => x.name === this.context.projectName)[0];
                if (!this.context.projectFilesDirectory) {
                    return Promise.reject("There is no project files directory");
                }
            });
        }).then(() => this.findAppDelegateFile());
    }

    private findAppDelegateFile() {
        return this.context.repository.walkTreeFromDirectory(this.context.projectFilesDirectory, (entry: IVCSRepositoryEntry) => {
            if (!entry.isDirectory) {
                const name = entry.name.toLowerCase();
                if (name === "appdelegate.swift" || name == "appdelegate.m") {
                    return entry;
                }
            }
        }).then(appDelegateFile => {
            if (!appDelegateFile) {
                return Promise.reject("There is no AppDelegate file");
            }

            this.context.appDelegateFile = appDelegateFile;
        });
    }
}

class AddCocoapodsDependencies extends SDKIntegrationStep {
    protected step() {
        const podfile = this.context.repository.getEntryByPath(Path.join(this.context.projectRootDirectory.path, "Podfile"));

        let content = this.getContent(podfile);
        this.callIfSdkPartEnabled(() => {
            content = this.addService(content, "pod 'MobileCenter/MobileCenterAnalytics'");
        }, () => {
            content = this.addService(content, "pod 'MobileCenter/MobileCenterCrashes'");
        }, () => {
            content = this.addService(content, "pod 'MobileCenter/MobileCenterDistribute'");
        });

        this.context.actions.push(() => FS.writeFileSync(podfile.fullPath, content, { encoding: "utf8" }));
        
        if (Helpers.endsWith(this.context.appDelegateFile.name, ".swift")) {
            this.nextStep = new InsertSDKInAppDelegateSwift();
        } else {
            this.nextStep = new InsertSDKInAppDelegateObjectiveC();
        }
    }

    private getContent(podFile: IVCSRepositoryFileEntry): string {
        if (!FS.existsSync(podFile.fullPath)) {
            return `platform :ios, '8.0'\r\ntarget '${this.context.projectName}' do\r\n  use_frameworks!\r\nend`;
        } else {
            return FS.readFileSync(podFile.fullPath, "utf8");
        }
    }

    private getTargetIndexes(content: string): number[] {
        const regExp = new RegExp(`(target ['"]${this.context.projectName}['"] do[\\s\\S]*?\r\n)end`);
        const match = regExp.exec(content);
        if (match) {
            return [match.index, match.index + match[1].length];
        } else {
            return null;
        }
    }

    private addService(content: string, service: string) {
        const indexes = this.getTargetIndexes(content);
        if (indexes) {
            if (content.substr(indexes[0], indexes[1] - indexes[0]).indexOf(service) >= 0) {
                return content;
            }

            content = Helpers.splice(content, indexes[1], 0, `  ${service}\r\n`);
        } else {
            if (content.indexOf(service) >= 0) {
                return content;
            }

            content = content + "\r\n" + service;
        }

        return content;
    }
}

/*class CopySDKToProject extends SDKIntegrationStep {
    private static SDKBinariesPath = Path.join(__dirname, "..\\..\\..\\MobileCenter-SDK-iOS");
    protected nextStep = new AddSDKReferencesSDKIntegrationStep();
    protected step() {
        const targetPath = Path.join(this.context.projectRootDirectory.fullPath, this.sdkDirectoryName);
        if (!FS.existsSync(targetPath)) {
            FS.mkdirSync(targetPath);
        }

        const frameworkDirs = ["MobileCenter.framework"];
        this.callIfSdkPartEnabled(
            () => frameworkDirs.push("MobileCenterAnalytics.framework"),
            () => frameworkDirs.push("MobileCenterCrashes.framework"),
            () => {
                frameworkDirs.push("MobileCenterDistributeResources.bundle");
                frameworkDirs.push("MobileCenterDistribute.framework");
            });

        return Promise.all(frameworkDirs.map(x => this.copy(x, targetPath))).then((paths) => {
            this.context.sdkVendorDirectories = paths.map(x => this.context.repository.getEntryByPath(x + "\\") as IVCSRepositoryDirectoryEntry);
        });
    }

    private copy(dirName: string, targetDirPath: string): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            const sdkDirPath = Path.join(CopySDKToProjectSDKIntegrationStep.SDKBinariesPath, dirName);
            const targetPath = Path.join(this.context.projectRootDirectory.fullPath, this.sdkDirectoryName, Path.basename(sdkDirPath));
            if (!FS.existsSync(targetPath)) {
                FS.mkdirSync(targetPath);
            }

            ncp(sdkDirPath, targetPath, {}, error => {
                if (error) {
                    return reject(error);
                }

                resolve(targetPath);
            });
        });
    }
}

class AddSDKReferences extends SDKIntegrationStep  {
    protected step() {
        const project = Xcode.project(this.context.projectFile.fullPath);
        project.parseSync();
        this.createSDKPbxGroup(project);
        this.fixPBXFileReferences(project);
        this.addBuildPhaseFiles(project);
        this.addFrameworkSearchPaths(project);
        FS.writeFileSync(this.context.projectFile.fullPath, project.writeSync());

        if (true) { // TODO Add the Objective-C support.
            //this.nextStep = new InsertSDKInAppDelegateSwift();
        } else {

        }
    }

    private createSDKPbxGroup(project: any): any {
        let group = project.getPBXGroupByKey(project.findPBXGroupKeyAndType({ path: this.sdkDirectoryName }, "PBXGroup"));
        if (!group) {
            group = project.addPbxGroup(this.context.sdkVendorDirectories.map(x => x.fullPath), this.sdkDirectoryName, this.sdkDirectoryName, "SOURCE_ROOT");
        } else {

        }

        const firstpbxProject = project.getFirstProject(); // TODO - it works only with the first project.
        project.addToPbxGroup({ fileRef: group.uuid, basename: this.sdkDirectoryName }, firstpbxProject.firstProject.mainGroup);
    }

    private addBuildPhaseFiles(project: any) {
        const keys = this.getPbxBuildFileSectionSDKKeys(project);
        const section = project.pbxBuildFileSection();
        for (const key of keys.filter(x => Helpers.endsWith(section[x].fileRef_comment, ".framework"))) {
            const frameworkChild = section[key];
            project.addToPbxFrameworksBuildPhase({ uuid: key, basename: frameworkChild.fileRef_comment, group: "Frameworks" });
        }

        for (const key of keys.filter(x => Helpers.endsWith(section[x].fileRef_comment, ".bundle"))) {
            const frameworkChild = section[key];
            project.addToPbxResourcesBuildPhase({ uuid: key, basename: frameworkChild.fileRef_comment, group: "Resources" });
        }
    }

    private fixPBXFileReferences(project: any) {
        const keys = this.getPBXFileReferencesSectionSDKKeys(project);
        const section = project.pbxFileReferenceSection();
        for (const item of keys.map(x => section[x])) {
            delete item["explicitFileType"];
            delete item["fileEncoding"];
            delete item["includeInIndex"];
            item.path = this.unquote(item.name);
            delete item["name"];
            item.sourceTree = `"<group>"`;
        }
    }

    private addFrameworkSearchPaths(project: any) {
        const section = project.pbxXCBuildConfigurationSection()
        const INHERITED = `"$(inherited)"`;
        const searchPath = `"$(PROJECT_DIR)/${this.sdkDirectoryName}"`;
        for (const key of this.getSectionKeys(section)) {
            const buildSettings = section[key].buildSettings;
            if (!buildSettings || this.unquote(buildSettings["PRODUCT_NAME"]) != project.productName) {
                continue;
            }

            let frameworkSearchPaths: string[] = buildSettings["FRAMEWORK_SEARCH_PATHS"];
            if (!frameworkSearchPaths || !Array.isArray(frameworkSearchPaths)) {
                frameworkSearchPaths = [INHERITED];
                buildSettings["FRAMEWORK_SEARCH_PATHS"] = frameworkSearchPaths;
            }

            if (!frameworkSearchPaths.some(x => x === searchPath)) {
                frameworkSearchPaths.push(searchPath);
            }
        }
    }

    private getPbxBuildFileSectionSDKKeys(project: any) {
        const names = this.context.sdkVendorDirectories.map(x => x.name);
        const section = project.pbxBuildFileSection();
        return this.getSectionKeys(section).filter(x => names.some(n => n === section[x].fileRef_comment));
    }

    private getPBXFileReferencesSectionSDKKeys(project: any) {
        const names = this.context.sdkVendorDirectories.map(x => x.name);
        const section = project.pbxFileReferenceSection();
        return this.getSectionKeys(section).filter(x => names.some(n => `"${n}"` === section[x].name));
    }

    private getSectionKeys(section: any) {
        return Object.keys(section).filter(x => !Helpers.endsWith(x, "_comment"));
    }

    private unquote(str: string) {
        const result = /"(.+)"/.exec(str);
        return (result && result[1]) || str;
    }
}
*/

class InsertSDKInAppDelegateSwift extends SDKIntegrationStep {
    protected step() {
        let appDelegateContent = FS.readFileSync(this.context.appDelegateFile.fullPath, "utf8");
        const bag = this.analyze(appDelegateContent);

        // Need to keep this insertion order to avoid index shifting.
        appDelegateContent = this.insertStart(bag, appDelegateContent);
        appDelegateContent = this.insertImports(bag, appDelegateContent);
        this.context.actions.push(() => FS.writeFileSync(this.context.appDelegateFile.fullPath, appDelegateContent, { encoding: "utf8" }));
    }

    private analyze(appDelegateContent: string): TextWalkerSwiftInjectBag {
        const textWalker = new TextWalkerC(appDelegateContent, new TextWalkerSwiftInjectBag());
        textWalker.addTrap(bag => bag.significant
            && bag.blockLevel === 0
            && !bag.wasWithinClass
            && /import\s+?[\w\.]+?\r\n$/.test(textWalker.backpart),
            bag => {
                bag.endOfImportBlockIndex = textWalker.position;
            });
        textWalker.addTrap(bag =>
            bag.significant
            && bag.blockLevel === 1
            && textWalker.currentChar === "{",
            bag => {
                const matches = /\s*([a-z]+?\s+?|)(class|extension)\s+?AppDelegate(?!\w).*?$/.exec(textWalker.backpart);
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
                    match = /(\r\n|) *?$/.exec(textWalker.backpart);
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

        const imports: string[] = [];
        this.addImportIfNotExists(appDelegateContent, bag.endOfImportBlockIndex, imports, "MobileCenter");
        this.callIfSdkPartEnabled(
            () => this.addImportIfNotExists(appDelegateContent, bag.endOfImportBlockIndex, imports, "MobileCenterAnalytics"),
            () => this.addImportIfNotExists(appDelegateContent, bag.endOfImportBlockIndex, imports, "MobileCenterCrashes"),
            () => this.addImportIfNotExists(appDelegateContent, bag.endOfImportBlockIndex, imports, "MobileCenterDistribute"));

        const importsString = imports.map(x => `import ${x}\r\n`).join("");
        appDelegateContent = Helpers.splice(appDelegateContent, bag.endOfImportBlockIndex, 0, importsString);
        return appDelegateContent;
    }

    private addImportIfNotExists(appDelegateContent: string, index: number, imports: string[], item: string) {
        if (!new RegExp(`import +${item}\r\n`).test(appDelegateContent.substr(0, index))) {
            imports.push(item);
        }
    }

    private insertStart(bag: TextWalkerSwiftInjectBag, appDelegateContent: string): string {
        if (bag.applicationFuncStartIndex < 0) {
            throw new Error("Function 'application' is not defined in AppDelegate");
        }

        if (bag.msMobileCenterStartCallStartIndex >= 0) {
            appDelegateContent = Helpers.splice(appDelegateContent, bag.msMobileCenterStartCallStartIndex, bag.msMobileCenterStartCallLength, "");
        }

        const services: string[] = [];
        this.callIfSdkPartEnabled(
            () => services.push("MSAnalytics.self"),
            () => services.push("MSCrashes.self"),
            () => services.push("MSDistribute.self"));

        const start = `MSMobileCenter.start("${this.context.applicationToken}", withServices: [${services.join(", ")}])`;
        appDelegateContent = Helpers.splice(appDelegateContent, bag.applicationFuncStartIndex, 0, `\r\n        ${start}`);
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
        let appDelegateContent = FS.readFileSync(this.context.appDelegateFile.fullPath, "utf8");
        const bag = this.analyze(appDelegateContent);

        // Need to keep this insertion order to avoid index shifting.
        appDelegateContent = this.insertStart(bag, appDelegateContent);
        appDelegateContent = this.insertImports(bag, appDelegateContent);
        this.context.actions.push(() => FS.writeFileSync(this.context.appDelegateFile.fullPath, appDelegateContent, { encoding: "utf8" }));
    }

    private analyze(appDelegateContent: string): TextWalkerObjectiveCInjectBag {
        const textWalker = new TextWalkerC(appDelegateContent, new TextWalkerObjectiveCInjectBag());
        textWalker.addTrap(bag => bag.significant
            && bag.blockLevel === 0
            && !bag.isWithinImplementation
            && /[@#]import\s+?[\w"<>\/\.]+?;?\r\n$/.test(textWalker.backpart),
            bag => {
                bag.endOfImportBlockIndex = textWalker.position;
            });
        textWalker.addTrap(bag =>
            bag.significant
            && bag.blockLevel === 0
            && Helpers.startsWith(textWalker.forepart, "@implementation"),
            bag => {
                const matches = /^@implementation\s+?AppDelegate\r\n/.exec(textWalker.forepart);
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
                const matches = /-\s*?\(\s*?[\w\.]+?\s*?\)\s*application(?!\w)[\s\S]*?$/.exec(textWalker.backpart)
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
                    match = /(\r\n|) *?$/.exec(textWalker.backpart);
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

        const imports: string[] = [];
        this.addImportIfNotExists(appDelegateContent, bag.endOfImportBlockIndex, imports, "MobileCenter");
        this.callIfSdkPartEnabled(
            () => this.addImportIfNotExists(appDelegateContent, bag.endOfImportBlockIndex, imports, "MobileCenterAnalytics"),
            () => this.addImportIfNotExists(appDelegateContent, bag.endOfImportBlockIndex, imports, "MobileCenterCrashes"),
            () => this.addImportIfNotExists(appDelegateContent, bag.endOfImportBlockIndex, imports, "MobileCenterDistribute"));

        const importsString = imports.map(x => `@import ${x};\r\n`).join("");
        appDelegateContent = Helpers.splice(appDelegateContent, bag.endOfImportBlockIndex, 0, importsString);
        return appDelegateContent;
    }

    private addImportIfNotExists(appDelegateContent: string, index: number, imports: string[], item: string) {
        if (!new RegExp(`@import +${item} *?;\r\n`).test(appDelegateContent.substr(0, index))) {
            imports.push(item);
        }
    }

    private insertStart(bag: TextWalkerObjectiveCInjectBag, appDelegateContent: string): string {
        if (bag.applicationFuncStartIndex < 0) {
            throw new Error("Function 'application' is not defined in AppDelegate");
        }

        if (bag.msMobileCenterStartCallStartIndex >= 0) {
            appDelegateContent = Helpers.splice(appDelegateContent, bag.msMobileCenterStartCallStartIndex, bag.msMobileCenterStartCallLength, "");
        }

        const services: string[] = [];
        this.callIfSdkPartEnabled(
            () => services.push("[MSAnalytics class]"),
            () => services.push("[MSCrashes class]"),
            () => services.push("[MSDistribute class]"));

        const start = `[MSMobileCenter start:@"${this.context.applicationToken}" withServices:@[${services.join(", ")}]];`
        appDelegateContent = Helpers.splice(appDelegateContent, bag.applicationFuncStartIndex, 0, `\r\n    ${start}`);
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
