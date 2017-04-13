interface IVCSRepository {
    getRootEntry(): IVCSRepositoryDirectoryEntry;
    getEntryByPath(path: string): IVCSRepositoryEntry;
}

interface IVCSRepositoryEntry {
    name: string;
    path: string;
    fullPath: string;
    isDirectory: boolean;
}

interface IVCSRepositoryFileEntry extends IVCSRepositoryEntry {

}

interface IVCSRepositoryDirectoryEntry extends IVCSRepositoryEntry {
    getEntries(): Promise<IVCSRepositoryEntry[]>;
    getFileEntries(): Promise<IVCSRepositoryFileEntry[]>;
    getDirectoryEntries(): Promise<IVCSRepositoryDirectoryEntry[]>;
}