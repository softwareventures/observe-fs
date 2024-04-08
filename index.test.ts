import {mkdir, open, rename, rm, rmdir} from "node:fs/promises";
import * as os from "node:os";
import {resolve, sep} from "node:path";
import test from "ava";
import {temporaryDirectoryTask, temporaryFileTask} from "tempy";
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
import {any, fold, last, push} from "@softwareventures/array";
import type {FileEvent} from "./index.js";
import {observeFileEvents} from "./index.js";

const nodeMajorVersion = parseInt(notNull(process.version.split(".")[0]), 10);

test("observeFileEvents: file no actions", async t => {
    t.deepEqual(await testFileEvents(async () => {}), []);
});

test("observeFileEvents: open file for append and close", async t => {
    t.deepEqual(
        (
            await testFileEvents(async path => {
                const file = await open(path, "a");
                await file.close();
            })
        ).map(({event}) => event),
        []
    );
});

test("observeFileEvents: open file for write and close", async t => {
    t.deepEqual(
        (
            await testFileEvents(async path => {
                const file = await open(path, "w");
                await file.close();
            })
        ).map(({event}) => event),
        ["change"]
    );
});

test("observeFileEvents: open file for write, write text and close", async t => {
    t.deepEqual(
        (
            await testFileEvents(async path => {
                const file = await open(path, "w");
                await file.write("test");
                await file.close();
            })
        ).map(({event}) => event),
        ["change", "change"]
    );
});

test("observeFileEvents: open file for write, write text, close, open same file for append, write text, and close", async t => {
    t.deepEqual(
        (
            await testFileEvents(async path => {
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
});

test("observeFileEvents: rename file", async t => {
    t.deepEqual(
        (
            await testFileEvents(async path => {
                await rename(path, `${path}_renamed`);
            })
        ).map(({event}) => event),
        ["rename"]
    );
});

test("observeFileEvents: delete file", async t => {
    t.deepEqual(
        (
            await testFileEvents(async path => {
                await rm(path);
            })
        ).map(({event}) => event),
        os.platform() === "linux" ? ["change", "rename", "rename"] : ["rename"]
    );
});

// When observing a directory, both "rename" and "change" events are sometimes
// followed by an additional spurious "change" event for the same path.
// This function also omits genuine "change" events that follow a "rename"
// event, but it's good enough for testing.
function omitDuplicateChangeEvents(events: readonly FileEvent[]): FileEvent[] {
    return fold(
        events,
        (accumulator: FileEvent[], event) =>
            event.event === "change" && last(accumulator)?.path === event.path
                ? accumulator
                : push(accumulator, event),
        []
    );
}

test("observeFileEvents: observe directory non-recursive, no actions", async t => {
    // On MacOS, no events are ever emitted when watching a directory non-recursively.
    // That makes this functionality essentially useless on MacOS.
    t.deepEqual(await testDirectoryEvents(async () => {}), []);
});

test("observeFileEvents: observe directory non-recursive, open file for write and close", async t => {
    // On MacOS, no events are ever emitted when watching a directory non-recursively.
    // That makes this functionality essentially useless on MacOS.
    t.deepEqual(
        await testDirectoryEvents(async path => {
            const file = await open(resolve(path, "a"), "w");
            await file.close();
        }),
        os.platform() === "darwin" ? [] : [{event: "rename", path: "a"}]
    );
});

test("observeFileEvents: observe directory non-recursive, open file for write, write text, and close", async t => {
    t.deepEqual(
        omitDuplicateChangeEvents(
            await testDirectoryEvents(async path => {
                const file = await open(resolve(path, "a"), "w");
                await file.write("test");
                await file.close();
            })
        ),
        os.platform() === "darwin"
            ? []
            : [
                  {event: "rename", path: "a"}
                  // Followed by a "change" event which is omitted by omitDuplicateChangeEvents
              ]
    );
});

test("observeFileEvents: observe directory non-recursive, open file for write, write text, close, open another file for write, write text, and close", async t => {
    t.deepEqual(
        omitDuplicateChangeEvents(
            await testDirectoryEvents(async path => {
                const file = await open(resolve(path, "a"), "w");
                await file.write("test");
                await file.close();
                const file2 = await open(resolve(path, "b"), "w");
                await file2.write("test2");
                await file2.close();
            })
        ),
        os.platform() === "darwin"
            ? []
            : [
                  {event: "rename", path: "a"},
                  // Followed by a "change" event which is omitted by omitDuplicateChangeEvents
                  {event: "rename", path: "b"}
                  // Followed by a "change" event which is omitted by omitDuplicateChangeEvents
              ]
    );
});

test("observeFileEvents: observe directory non-recursive, open file for write, close, open another file for write, close, rename first file", async t => {
    t.deepEqual(
        await testDirectoryEvents(async path => {
            const pathA = resolve(path, "a");
            const pathB = resolve(path, "b");
            const pathC = resolve(path, "c");
            const file = await open(pathA, "w");
            await file.close();
            const file2 = await open(pathB, "w");
            await file2.close();
            await rename(pathA, pathC);
            await rm(pathB);
        }),
        os.platform() === "darwin"
            ? []
            : [
                  {event: "rename", path: "a"},
                  {event: "rename", path: "b"},
                  {event: "rename", path: "a"},
                  {event: "rename", path: "c"},
                  {event: "rename", path: "b"}
              ]
    );
});

test("observeFileEvents: observe directory non-recursive, make inner directory, open file for write in inner directory, close, move file to observed directory", async t => {
    t.deepEqual(
        omitDuplicateChangeEvents(
            await testDirectoryEvents(async path => {
                const pathA = resolve(path, "a");
                const pathB = resolve(pathA, "b");
                const pathC = resolve(path, "c");
                await mkdir(pathA);
                const file = await open(pathB, "w");
                await file.close();
                await rename(pathB, pathC);
                await rmdir(pathA);
            })
        ),
        os.platform() === "darwin"
            ? []
            : [
                  {event: "rename", path: "a"},
                  {event: "rename", path: "c"},
                  {event: "rename", path: "a"}
              ]
    );
});

test("observeFileEvents: observe directory non-recursive, delete observed directory", async t => {
    if (os.platform() === "win32") {
        await t.throwsAsync(
            testDirectoryEvents(async path => {
                await rmdir(path);
            }),
            {code: "EPERM"}
        );
    } else {
        // The "path" field in both events will be the name of the directory we are watching.
        t.deepEqual(
            (
                await testDirectoryEvents(async path => {
                    await rmdir(path);
                })
            ).map(({event}) => event),
            os.platform() === "darwin" ? [] : ["rename", "rename"]
        );
    }
});

// Recursive directory observation is unavailable on Linux
if (os.platform() !== "linux") {
    test("observeFileEvents: observe directory recursive, no actions", async t => {
        t.deepEqual(await testDirectoryEvents(async () => {}, true), []);
    });

    test("observeFileEvents: observe directory recursive, open file for write and close", async t => {
        t.deepEqual(
            omitDuplicateChangeEvents(
                await testDirectoryEvents(async path => {
                    const file = await open(resolve(path, "a"), "w");
                    await file.close();
                }, true)
            ),
            [{event: "rename", path: "a"}]
        );
    });

    test("observeFileEvents: observe directory recursive, open file for write, write text, and close", async t => {
        t.deepEqual(
            omitDuplicateChangeEvents(
                await testDirectoryEvents(async path => {
                    const file = await open(resolve(path, "a"), "w");
                    await file.write("test");
                    await file.close();
                }, true)
            ),
            [
                {event: "rename", path: "a"}
                // Followed by a "change" event which is omitted by omitDuplicateChangeEvents
            ]
        );
    });

    test("observeFileEvents: observe directory recursive, open file for write, write text, close, open another file for write, write text, close", async t => {
        t.deepEqual(
            omitDuplicateChangeEvents(
                await testDirectoryEvents(async path => {
                    const file = await open(resolve(path, "a"), "w");
                    await file.write("test");
                    await file.close();
                    const file2 = await open(resolve(path, "b"), "w");
                    await file2.write("test2");
                    await file2.close();
                }, true)
            ),
            [
                {event: "rename", path: "a"},
                // Followed by a "change" event which is omitted by omitDuplicateChangeEvents
                {event: "rename", path: "b"}
                // Followed by a "change" event which is omitted by omitDuplicateChangeEvents
            ]
        );
    });

    test("observeFileEvents: observe directory recursive, open file for write, close, open another file for write, close, rename first file", async t => {
        t.deepEqual(
            omitDuplicateChangeEvents(
                await testDirectoryEvents(async path => {
                    const pathA = resolve(path, "a");
                    const pathB = resolve(path, "b");
                    const pathC = resolve(path, "c");
                    const file = await open(pathA, "w");
                    await file.close();
                    const file2 = await open(pathB, "w");
                    await file2.close();
                    await rename(pathA, pathC);
                    await rm(pathB);
                }, true)
            ),
            [
                {event: "rename", path: "a"},
                {event: "rename", path: "b"},
                {event: "rename", path: "a"},
                {event: "rename", path: "c"},
                {event: "rename", path: "b"}
            ]
        );
    });

    test("observeFileEvents: observe directory recursive, make inner directory, open file for write in inner directory, close, move file to observed directory, delete inner directory", async t => {
        t.deepEqual(
            fold(
                await testDirectoryEvents(async path => {
                    const pathA = resolve(path, "a");
                    const pathB = resolve(pathA, "b");
                    const pathC = resolve(path, "c");
                    await mkdir(pathA);
                    const file = await open(pathB, "w");
                    await file.close();
                    await rename(pathB, pathC);
                    await rmdir(pathA);
                }, true),
                (accumulator: readonly FileEvent[], event) =>
                    event.event === "change" && last(accumulator)?.path === event.path
                        ? accumulator
                        : event.event === "change" &&
                            event.path === "a" &&
                            any(accumulator, e => e.event === "rename" && e.path === `a${sep}b`)
                          ? accumulator
                          : push(accumulator, event),
                []
            ),
            [
                {event: "rename", path: "a"},
                {event: "rename", path: `a${sep}b`},
                {event: "rename", path: `a${sep}b`},
                {event: "rename", path: "c"},
                {event: "rename", path: "a"}
            ]
        );
    });

    test("observeFileEvents: observe directory recursive, delete observed directory", async t => {
        if (os.platform() === "win32") {
            await t.throwsAsync(
                testDirectoryEvents(async path => {
                    await rmdir(path);
                }, true),
                {code: "EPERM"}
            );
        } else {
            // The "path" field in both events will be the name of the directory we are watching.
            t.deepEqual(
                (
                    await testDirectoryEvents(async path => {
                        await rmdir(path);
                    }, true)
                ).map(({event}) => event),
                ["rename", "rename"]
            );
        }
    });
}

async function testFileEvents(actions: (path: string) => Promise<void>): Promise<FileEvent[]> {
    return temporaryFileTask(async path => {
        const writeEmptyFile = async (): Promise<void> => {
            const file = await open(path, "w");
            await file.close();
        };

        await writeEmptyFile();

        return testEventsInternal({path, writeSentinel: writeEmptyFile, actions});
    });
}

async function testDirectoryEvents(
    actions: (path: string) => Promise<void>,
    recursive = false
): Promise<FileEvent[]> {
    return temporaryDirectoryTask(async path => {
        const sentinelPath = resolve(path, "sentinel");
        const writeSentinel = async (): Promise<void> => {
            const file = await open(sentinelPath, "w");
            await file.close();
            await rm(sentinelPath);
        };

        return testEventsInternal({path, writeSentinel, actions, recursive});
    });
}

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

interface TestEventsInternalOptions {
    readonly path: string;
    readonly writeSentinel: () => Promise<void>;
    readonly actions: (path: string) => Promise<void>;
    readonly recursive?: boolean | undefined;
}

async function testEventsInternal({
    path,
    writeSentinel,
    actions,
    recursive = false
}: TestEventsInternalOptions): Promise<FileEvent[]> {
    const requestSentinelEvents = interval(
        os.platform() === "win32" || os.platform() === "linux" ? 1 : 10
    ).pipe(map(() => "RequestSentinel" as const));
    const internalEvents = new Subject<InternalEvent>();
    const fileEvents = observeFileEvents({path, recursive});

    return firstValueFrom(
        requestSentinelEvents
            .pipe(
                takeUntil(
                    internalEvents.pipe(
                        filter(
                            event =>
                                event === "SeenWritingSentinel" || event === "SeenWrittenSentinel"
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
                                      delay(
                                          os.platform() === "win32" || os.platform() === "linux"
                                              ? 4
                                              : 100
                                      )
                                  )
                                : EMPTY
                        )
                    )
                ),
                switchMap(({event, state}) => {
                    if (state === "Done") {
                        const delayDone = of({event: "Done", state: "Done"}).pipe(
                            delay(os.platform() === "win32" || os.platform() === "linux" ? 20 : 200)
                        );
                        if (event === "Done") {
                            return delayDone;
                        } else {
                            return of({event, state}).pipe(concatWith(delayDone));
                        }
                    } else {
                        return of({event, state});
                    }
                }),
                tap(({event, state}) => {
                    if (event === "RequestSentinel") {
                        if (state === "Init") {
                            internalEvents.next("WritingSentinel");
                            void writeSentinel().then(
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
                            (reason: unknown) => void internalEvents.next({event: "Error", reason})
                        );
                    } else if (typeof event === "object") {
                        if (state === "Init" || state === "SeenWrittenSentinel") {
                            internalEvents.next("SeenWrittenSentinel");
                        } else if (state === "WritingSentinel" || state === "SeenWritingSentinel") {
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
}
