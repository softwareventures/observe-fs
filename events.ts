import type {WatchEventType} from "node:fs";
import {watch} from "node:fs";
import {resolve} from "node:path";
import {Observable} from "rxjs";

export interface FileEvent {
    readonly event: WatchEventType;
    readonly path: string | null;
}

export interface ObserveFileEventsOptions {
    readonly path: string;
    readonly recursive?: boolean | undefined;
}

export function observeFileEvents(
    options: string | ObserveFileEventsOptions
): Observable<FileEvent> {
    const path = typeof options === "string" ? options : options.path;
    const recursive = typeof options === "object" ? options.recursive ?? false : false;
    const absolutePath = resolve(path);
    return new Observable(subscriber => {
        const abortController = new AbortController();
        const watcher = watch(
            absolutePath,
            {signal: abortController.signal, recursive},
            (event, path) => void subscriber.next({event, path})
        );
        watcher.addListener("error", error => void subscriber.error(error));
        return () => {
            abortController.abort();
        };
    });
}
