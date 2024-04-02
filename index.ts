import type {WatchEventType} from "node:fs";
import {watch} from "node:fs";
import {resolve} from "node:path";
import {Observable} from "rxjs";

export interface FileEvent {
    readonly event: WatchEventType;
    readonly path: string | null;
}

export function observeFileEvents(path: string): Observable<FileEvent> {
    const absolutePath = resolve(path);
    return new Observable(subscriber => {
        const abortController = new AbortController();
        const watcher = watch(
            absolutePath,
            {signal: abortController.signal},
            (event, path) => void subscriber.next({event, path})
        );
        watcher.addListener("error", error => void subscriber.error(error));
        return () => {
            abortController.abort();
        };
    });
}
