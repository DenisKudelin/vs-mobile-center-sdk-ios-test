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