/// <reference path="./models.d.ts" />
import * as Path from "path";
import * as Promise from "bluebird";
import * as FS from "fs";
import * as Helpers from "../Helpers/Helpers";

export class VCSRepository implements IVCSRepository {
    private rootPath: string;

    constructor(rootPath: string) {
        this.rootPath = rootPath;
    }

    public getEntryByPath(path: string): IVCSRepositoryEntry {
        if (Helpers.endsWith(path, "\\")) {
            return this.createVCSRepositoryDirectoryEntry(path);
        } else {
            return this.createVCSRepositoryFileEntry(path);
        }
    }

    public getRootEntry(): IVCSRepositoryDirectoryEntry {
        return this.getEntryByPath("\\") as IVCSRepositoryDirectoryEntry;
    }

    private readDirectory(path: string): Promise<string[]> {
        return new Promise<string[]>((resolve, reject) => {
            path = Path.join(this.rootPath, path);
            FS.readdir(path, (err, data) => {
                if (err) {
                    return reject(err);
                }

                const pathList = data
                    .map(x => Path.relative(this.rootPath, Path.join(path, x)))
                    .map(x => ("\\" + x) + (FS.lstatSync(Path.join(this.rootPath, x)).isDirectory() ? "\\" : ""))
                resolve(pathList);
            });
        });
    }

    private createVCSRepositoryFileEntry(path: string): IVCSRepositoryFileEntry {
        path = Path.normalize(path)
        return {
            name: Path.basename(path),
            path: path,
            fullPath: Path.join(this.rootPath, path),
            isDirectory: false
        };
    }

    private createVCSRepositoryDirectoryEntry(path: string): IVCSRepositoryDirectoryEntry {
        path = Path.normalize(path + "\\");
        return {
            name: Path.basename(path),
            path: path,
            fullPath: Path.join(this.rootPath, path) + "\\",
            getFileEntries: () => this.readDirectory(path).then((entryPathList: string[]) => entryPathList.filter(x => !Helpers.endsWith(x, "\\")).map(x => this.getEntryByPath(x))),
            getDirectoryEntries: () => this.readDirectory(path).then((entryPathList: string[]) => entryPathList.filter(x => Helpers.endsWith(x, "\\")).map(x => this.getEntryByPath(x))),
            getEntries: () => this.readDirectory(path).then((entryPathList: string[]) => entryPathList.map(x => this.getEntryByPath(x))),
            isDirectory: true
        };
    }

    public walkTree(predicate: (IVCSRepositoryEntry) => any): Promise<any> {
        return this.walkTreeFromDirectory(this.getRootEntry(), predicate);
    }

    public walkTreeFromDirectory(rootDirectory: IVCSRepositoryDirectoryEntry, predicate: (IVCSRepositoryEntry) => any): Promise<any> {
        const directories: IVCSRepositoryDirectoryEntry[] = [rootDirectory];
        const cycle = () => {
            return directories.shift().getEntries().then(entries => {
                for (const entry of entries) {
                    const result = predicate(entry);
                    if (result) {
                        return result;
                    }
                }

                for (const directory of entries.filter(x => x.isDirectory) as IVCSRepositoryDirectoryEntry[]) {
                    directories.push(directory);
                }

                if (directories.length) {
                    return cycle();
                }
            });
        };
        return cycle();
    }
}
