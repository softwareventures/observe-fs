import {open, rename, rm} from "node:fs/promises";
import * as os from "node:os";
import test from "ava";
import {temporaryFileTask} from "tempy";
import {EMPTY, firstValueFrom, interval, of, Subject} from "rxjs";
import {
    concatWith,
    delay,
    filter,
    map,
    mergeMap,
    mergeWith,
    scan,
    skipWhile,
    switchMap,
    takeUntil,
    takeWhile,
    toArray,
    tap
} from "rxjs/operators";
import {notNull} from "@softwareventures/nullable";
import type {FileEvent} from "./index.js";
import {observeFileEvents} from "./index.js";

const nodeMajorVersion = parseInt(notNull(process.version.split(".")[0]), 10);

test("observeFileEvents", async t => {
    t.deepEqual(await testFileObservable(async () => {}), []);
    t.deepEqual(
        (
            await testFileObservable(async path => {
                const file = await open(path, "a");
                await file.close();
            })
        ).map(({event}) => event),
        []
    );
    t.deepEqual(
        (
            await testFileObservable(async path => {
                const file = await open(path, "w");
                await file.close();
            })
        ).map(({event}) => event),
        ["change"]
    );
    t.deepEqual(
        (
            await testFileObservable(async path => {
                const file = await open(path, "w");
                await file.write("test");
                await file.close();
            })
        ).map(({event}) => event),
        ["change", "change"]
    );
    t.deepEqual(
        (
            await testFileObservable(async path => {
                const file = await open(path, "w");
                await file.write("test");
                await file.close();
                const file2 = await open(path, "a");
                await file2.write("test2");
                await file2.close();
            })
        ).map(({event}) => event),
        [
            "change",
            "change",
            "change",
            ...(os.platform() === "darwin" && nodeMajorVersion >= 20 ? ["rename"] : [])
        ]
    );
    t.deepEqual(
        (
            await testFileObservable(async path => {
                await rename(path, `${path}_renamed`);
            })
        ).map(({event}) => event),
        ["rename"]
    );
    t.deepEqual(
        (
            await testFileObservable(async path => {
                await rm(path);
            })
        ).map(({event}) => event),
        os.platform() === "linux" ? ["change", "rename", "rename"] : ["rename"]
    );
});

type InternalEvent =
    | "WritingSentinel"
    | "WroteSentinel"
    | "SeenWritingSentinel"
    | "SeenWrittenSentinel"
    | "Ready"
    | "Done"
    | {readonly event: "Error"; readonly reason: unknown};

type ScannedInternalEvent =
    | "Init"
    | "RequestSentinel"
    | "WritingSentinel"
    | "WroteSentinel"
    | "SeenWritingSentinel"
    | "SeenWrittenSentinel"
    | "Ready"
    | "Done";

type InternalState =
    | "Init"
    | "WritingSentinel"
    | "SeenWritingSentinel"
    | "SeenWrittenSentinel"
    | "Ready"
    | "Done";

async function testFileObservable(actions: (path: string) => Promise<void>): Promise<FileEvent[]> {
    return temporaryFileTask(async path => {
        const requestSentinelEvents = interval(1).pipe(map(() => "RequestSentinel" as const));
        const internalEvents = new Subject<InternalEvent>();
        const fileEvents = observeFileEvents(path);

        const writeEmptyFile = async (): Promise<void> => {
            const file = await open(path, "w");
            await file.write("");
            await file.close();
        };

        await writeEmptyFile();

        return firstValueFrom(
            requestSentinelEvents
                .pipe(
                    takeUntil(
                        internalEvents.pipe(
                            filter(
                                event =>
                                    event === "SeenWritingSentinel" ||
                                    event === "SeenWrittenSentinel"
                            )
                        )
                    ),
                    mergeWith(
                        fileEvents,
                        internalEvents.pipe(
                            map(event => {
                                if (typeof event === "object") {
                                    throw event.reason;
                                } else {
                                    return event;
                                }
                            })
                        )
                    ),
                    scan(
                        (
                            previous: {
                                readonly event: ScannedInternalEvent | FileEvent;
                                readonly state: InternalState;
                            },
                            event
                        ) =>
                            event === "WritingSentinel" ||
                            event === "SeenWritingSentinel" ||
                            event === "SeenWrittenSentinel" ||
                            event === "Ready" ||
                            event === "Done"
                                ? ({event, state: event} as const)
                                : event === "WroteSentinel"
                                  ? previous.state === "SeenWritingSentinel"
                                      ? ({
                                            event: "SeenWrittenSentinel",
                                            state: "SeenWrittenSentinel"
                                        } as const)
                                      : ({event: "WroteSentinel", state: "Init"} as const)
                                  : {event, state: previous.state},
                        {event: "Init", state: "Init"} as const
                    ),
                    switchMap(({event, state}) =>
                        of({event, state}).pipe(
                            concatWith(
                                event === "SeenWrittenSentinel"
                                    ? of({event: "DelayAfterSeenSentinel", state} as const).pipe(
                                          delay(2)
                                      )
                                    : EMPTY
                            )
                        )
                    ),
                    mergeMap(({event, state}) =>
                        event === "Done" ? of({event, state}).pipe(delay(4)) : of({event, state})
                    ),
                    tap(({event, state}) => {
                        if (event === "RequestSentinel") {
                            if (state === "Init") {
                                internalEvents.next("WritingSentinel");
                                void writeEmptyFile().then(
                                    () => void internalEvents.next("WroteSentinel")
                                );
                            }
                        } else if (event === "DelayAfterSeenSentinel") {
                            if (state === "SeenWrittenSentinel") {
                                internalEvents.next("Ready");
                            }
                        } else if (event === "Ready") {
                            void actions(path).then(
                                () => void internalEvents.next("Done"),
                                (reason: unknown) =>
                                    void internalEvents.next({event: "Error", reason})
                            );
                        } else if (typeof event === "object") {
                            if (state === "Init" || state === "SeenWrittenSentinel") {
                                internalEvents.next("SeenWrittenSentinel");
                            } else if (
                                state === "WritingSentinel" ||
                                state === "SeenWritingSentinel"
                            ) {
                                internalEvents.next("SeenWritingSentinel");
                            }
                        }
                    })
                )
                .pipe(
                    skipWhile(({event}) => event !== "Ready"),
                    takeWhile(({event}) => event !== "Done"),
                    mergeMap(({event}) => (typeof event === "object" ? of(event) : EMPTY)),
                    toArray()
                )
        );
    });
}
