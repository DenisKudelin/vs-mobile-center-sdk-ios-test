declare module 'globule' {
    interface IsMatchOptions {
        matchBase?: boolean;
        srcBase?: string;
        filter?: any;
    }

    interface FindOptions {
        src?: string;
        filter?: string;
        nonull?: boolean;
        matchBase?: boolean;
        srcBase?: string;
        prefixBase?: boolean;
    }

    export function isMatch(patterns: string[] | string, filepaths: string[] | string, options?: IsMatchOptions): boolean;
    export function find(glob: string[] | string, options?: FindOptions): string[];
}