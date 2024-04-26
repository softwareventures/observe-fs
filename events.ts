import {watch} from "node:fs";
import {resolve} from "node:path";
import * as os from "node:os";
import {mergeMap, Observable, timer} from "rxjs";
import {map, mergeWith} from "rxjs/operators";

export type FileEvent = ReadyEvent | RenameEvent | ChangeEvent;

export interface ReadyEvent {
    readonly event: "Ready";
}

export interface RenameEvent {
    readonly event: "Rename";
    readonly path: string | null;
}

export interface ChangeEvent {
    readonly event: "Change";
    readonly path: string | null;
}

export interface ObserveFileEventsOptions {
    readonly path: string;
    readonly recursive?: boolean | undefined;
}

const platform = os.platform();

export function observeFileEvents(
    options: string | ObserveFileEventsOptions
): Observable<FileEvent> {
    const path = typeof options === "string" ? options : options.path;
    const recursive = typeof options === "object" ? options.recursive ?? false : false;
    const absolutePath = resolve(path);

    const events = new Observable<FileEvent>(subscriber => {
        const abortController = new AbortController();
        const watcher = watch(
            absolutePath,
            {signal: abortController.signal, recursive},
            (event, path) => {
                if (event === "rename") {
                    subscriber.next({event: "Rename", path} as const);
                } else if (event === "change") {
                    subscriber.next({event: "Change", path} as const);
                }
            }
        );

        // On Windows and Linux, the watcher is ready as soon as fs.watch returns.
        if (platform === "win32" || platform === "linux") {
            subscriber.next({event: "Ready"});
        }

        watcher.addListener("error", error => void subscriber.error(error));
        return () => {
            abortController.abort();
        };
    });

    if (platform === "win32" || platform === "linux") {
        return events;
    } else {
        // On macOS, we can't know for sure when the watcher is ready.
        // So, we just report it as ready when the first event comes through,
        // or after 400ms, whichever comes first.
        // See https://github.com/nodejs/node/issues/52601
        return timer(200).pipe(
            map(() => ({event: "Ready"}) as const),
            mergeWith(events),
            mergeMap((event, index) => [
                ...(index === 0 ? [{event: "Ready"} as const] : []),
                ...(event.event === "Ready" ? [] : [event])
            ])
        );
    }
}
