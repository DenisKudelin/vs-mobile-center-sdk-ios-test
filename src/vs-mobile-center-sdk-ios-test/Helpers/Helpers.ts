export function endsWith(str: string, suffix: string) {
    return str.indexOf(suffix, str.length - suffix.length) !== -1;
}

export function startsWith(str: string, prefix: string) {
    return str.lastIndexOf(prefix, 0) === 0;
}

export function splice(str: string, start: number, delCount: number, newSubStr: string) {
    return str.slice(0, start) + newSubStr + str.slice(start + Math.abs(delCount));
}

export function findIndex<T>(array: Array<T>, predicate: (item: T) => boolean) {
    for (let i = 0; i < array.length; i++) {
        if (predicate(array[i])) {
            return i;
        }
    }

    return -1;
}