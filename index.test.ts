import {mkdir, open, rename, rm, rmdir} from "node:fs/promises";
import * as os from "node:os";
import {resolve, sep} from "node:path";
import type {WatchEventType} from "node:fs";
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
    tap,
    toArray
} from "rxjs/operators";
import {
    all,
    first,
    fold,
    initial,
    last,
    partition,
    partitionWhile,
    tail
} from "@softwareventures/array";
import type {FileEvent} from "./index.js";
import {observeFileEvents} from "./index.js";

test("observeFileEvents: file no actions", async t => {
    t.deepEqual(await testFileEvents(async () => {}), []);
});

test("observeFileEvents: open file for append and close", async t => {
    t.deepEqual(
        await testFileEvents(async path => {
            const file = await open(path, "a");
            await file.close();
        }),
        []
    );
});

test("observeFileEvents: open file for write and close", async t => {
    t.deepEqual(
        eventNamesOnly(
            await testFileEvents(async path => {
                const file = await open(path, "w");
                await file.close();
            })
        ),
        ["change"]
    );
});

test("observeFileEvents: open file for write, write text and close", async t => {
    const events = await testFileEvents(async path => {
        const file = await open(path, "w");
        await file.write("test");
        await file.close();
    });
    if (os.platform() === "win32" || os.platform() === "linux") {
        t.deepEqual(eventNamesOnly(omitDuplicateChange(events)), ["change"]);
    } else {
        t.deepEqual(eventNamesOnly(omitDuplicateChange(omitRenameAfterChange(events))), ["change"]);
    }
});

test("observeFileEvents: open file for write, write text, close, open same file for append, write text, and close", async t => {
    const events = await testFileEvents(async path => {
        const file = await open(path, "w");
        await file.write("test");
        await file.close();
        const file2 = await open(path, "a");
        await file2.write("test2");
        await file2.close();
    });

    // Expect at least two "change" events, but possibly more.
    // When a file is opened and then written, this generates at least one
    // change event, but sometimes more than one.
    // Since we open and write the file twice, there should be at least
    // two "change" events.
    t.deepEqual(
        eventNamesOnly(
            fold(
                os.platform() === "win32" || os.platform() === "linux"
                    ? events
                    : omitRenameAfterChange(events),
                (accumulator: FileEvent[], event) =>
                    event.event === "change" &&
                    last(accumulator)?.event === "change" &&
                    last(accumulator)?.path === event.path &&
                    last(initial(accumulator))?.event === "change" &&
                    last(initial(accumulator))?.path === event.path
                        ? accumulator
                        : [...accumulator, event],
                []
            )
        ),
        ["change", "change"]
    );
});

test("observeFileEvents: rename file", async t => {
    t.deepEqual(
        eventNamesOnly(
            await testFileEvents(async path => {
                await rename(path, `${path}_renamed`);
            })
        ),
        ["rename"]
    );
});

test("observeFileEvents: delete file", async t => {
    t.deepEqual(
        eventNamesOnly(
            await testFileEvents(async path => {
                await rm(path);
            })
        ),
        os.platform() === "linux" ? ["change", "rename", "rename"] : ["rename"]
    );
});

test("observeFileEvents: observe directory non-recursive, no actions", async t => {
    t.deepEqual(await testDirectoryEvents(async () => {}), []);
});

test("observeFileEvents: observe directory non-recursive, open file for write and close", async t => {
    t.deepEqual(
        await testDirectoryEvents(async path => {
            const file = await open(resolve(path, "a"), "w");
            await file.close();
        }),
        [{event: "rename", path: "a"}]
    );
});

test("observeFileEvents: observe directory non-recursive, open file for write, write text, and close", async t => {
    const events = await testDirectoryEvents(async path => {
        const file = await open(resolve(path, "a"), "w");
        await file.write("test");
        await file.close();
    });
    if (os.platform() === "win32") {
        t.deepEqual(omitDuplicateChange(events), [
            {event: "rename", path: "a"},
            {event: "change", path: "a"}
        ]);
    } else if (os.platform() === "linux") {
        t.deepEqual(omitChangeAfterRename(events), [{event: "rename", path: "a"}]);
    } else {
        t.deepEqual(omitChangeAfterRename(omitRenameAfterChange(omitDuplicateRename(events))), [
            {event: "rename", path: "a"}
        ]);
    }
});

test("observeFileEvents: observe directory non-recursive, open file for write, write text, close, open another file for write, write text, and close", async t => {
    const events = await testDirectoryEvents(async path => {
        const file = await open(resolve(path, "a"), "w");
        await file.write("test");
        await file.close();
        const file2 = await open(resolve(path, "b"), "w");
        await file2.write("test2");
        await file2.close();
    });
    if (os.platform() === "win32") {
        t.deepEqual(omitDuplicateChange(events), [
            {event: "rename", path: "a"},
            {event: "change", path: "a"},
            {event: "rename", path: "b"},
            {event: "change", path: "b"}
        ]);
    } else if (os.platform() === "linux") {
        t.deepEqual(omitChangeAfterRename(events), [
            {event: "rename", path: "a"},
            {event: "rename", path: "b"}
        ]);
    } else {
        t.deepEqual(omitChangeAfterRename(omitRenameAfterChange(omitDuplicateRename(events))), [
            {event: "rename", path: "a"},
            {event: "rename", path: "b"}
        ]);
    }
});

test("observeFileEvents: observe directory non-recursive, open file for write, close, open another file for write, close, rename first file", async t => {
    const events = await testDirectoryEvents(async path => {
        const pathA = resolve(path, "a");
        const pathB = resolve(path, "b");
        const pathC = resolve(path, "c");
        const file = await open(pathA, "w");
        await file.close();
        const file2 = await open(pathB, "w");
        await file2.close();
        await rename(pathA, pathC);
        await rm(pathB);
    });
    if (os.platform() === "win32" || os.platform() === "linux") {
        t.deepEqual(events, [
            {event: "rename", path: "a"},
            {event: "rename", path: "b"},
            {event: "rename", path: "a"},
            {event: "rename", path: "c"},
            {event: "rename", path: "b"}
        ]);
    } else {
        // When a file is moved, renamed, or deleted, sometimes the events
        // pertaining to the file before it was moved, renamed, or deleted
        // are omitted.
        const [aEvents, otherEvents] = partition(events, event => event.path === "a");
        const [bEvents, otherEvents2] = partition(otherEvents, event => event.path === "b");
        const [cEvents, unexpectedEvents] = partition(otherEvents2, event => event.path === "c");
        t.deepEqual(first(aEvents), {event: "rename", path: "a"});
        t.true(all(tail(aEvents), event => event.event === "rename"));
        t.deepEqual(first(bEvents), {event: "rename", path: "b"});
        t.true(all(tail(bEvents), event => event.event === "rename"));
        t.deepEqual(cEvents, [{event: "rename", path: "c"}]);
        t.deepEqual(unexpectedEvents, []);
    }
});

test("observeFileEvents: observe directory non-recursive, make inner directory, open file for write in inner directory, close, move file to observed directory", async t => {
    const events = await testDirectoryEvents(async path => {
        const pathA = resolve(path, "a");
        const pathB = resolve(pathA, "b");
        const pathC = resolve(path, "c");
        await mkdir(pathA);
        const file = await open(pathB, "w");
        await file.close();
        await rename(pathB, pathC);
        await rmdir(pathA);
    });
    if (os.platform() === "win32") {
        // Creating a file in the watched directory sometimes, but not always,
        // generates a "change" event for the watched directory.
        const [aEvents, otherEvents] = partitionWhile(events, event => event.path === "a");
        t.deepEqual(first(aEvents), {event: "rename", path: "a"});
        t.true(all(tail(aEvents), event => event.event === "change"));
        t.deepEqual(otherEvents, [
            {event: "rename", path: "c"},
            {event: "rename", path: "a"}
        ]);
    } else if (os.platform() === "linux") {
        t.deepEqual(events, [
            {event: "rename", path: "a"},
            {event: "rename", path: "c"},
            {event: "rename", path: "a"}
        ]);
    } else {
        // When a file is moved, renamed, or deleted, sometimes the events
        // pertaining to the file before it was moved, renamed, or deleted
        // are omitted.
        const [aEvents, otherEvents] = partition(events, event => event.path === "a");
        const [cEvents, unexpectedEvents] = partition(otherEvents, event => event.path === "c");
        t.deepEqual(first(aEvents), {event: "rename", path: "a"});
        t.true(all(tail(aEvents), event => event.event === "rename"));
        t.deepEqual(cEvents, [{event: "rename", path: "c"}]);
        t.deepEqual(unexpectedEvents, []);
    }
});

test("observeFileEvents: observe directory non-recursive, delete observed directory", async t => {
    const events = testDirectoryEvents(async path => {
        await rmdir(path);
    });
    if (os.platform() === "win32") {
        await t.throwsAsync(events, {code: "EPERM"});
    } else if (os.platform() === "linux") {
        // The "path" field in both events will be the name of the directory we are watching.
        t.deepEqual(eventNamesOnly(await events), ["rename", "rename"]);
    } else {
        t.deepEqual(await events, []);
    }
});

// Recursive directory observation is unavailable on Linux
if (os.platform() !== "linux") {
    test("observeFileEvents: observe directory recursive, no actions", async t => {
        t.deepEqual(await testDirectoryEvents(async () => {}, true), []);
    });

    test("observeFileEvents: observe directory recursive, open file for write and close", async t => {
        t.deepEqual(
            await testDirectoryEvents(async path => {
                const file = await open(resolve(path, "a"), "w");
                await file.close();
            }, true),
            [{event: "rename", path: "a"}]
        );
    });

    test("observeFileEvents: observe directory recursive, open file for write, write text, and close", async t => {
        const events = await testDirectoryEvents(async path => {
            const file = await open(resolve(path, "a"), "w");
            await file.write("test");
            await file.close();
        }, true);
        if (os.platform() === "win32") {
            t.deepEqual(omitDuplicateChange(events), [
                {event: "rename", path: "a"},
                {event: "change", path: "a"}
            ]);
        } else {
            t.deepEqual(omitChangeAfterRename(omitRenameAfterChange(omitDuplicateRename(events))), [
                {event: "rename", path: "a"}
            ]);
        }
    });

    test("observeFileEvents: observe directory recursive, open file for write, write text, close, open another file for write, write text, close", async t => {
        const events = await testDirectoryEvents(async path => {
            const file = await open(resolve(path, "a"), "w");
            await file.write("test");
            await file.close();
            const file2 = await open(resolve(path, "b"), "w");
            await file2.write("test2");
            await file2.close();
        }, true);
        if (os.platform() === "win32") {
            t.deepEqual(omitDuplicateChange(events), [
                {event: "rename", path: "a"},
                {event: "change", path: "a"},
                {event: "rename", path: "b"},
                {event: "change", path: "b"}
            ]);
        } else {
            t.deepEqual(omitChangeAfterRename(omitRenameAfterChange(omitDuplicateRename(events))), [
                {event: "rename", path: "a"},
                {event: "rename", path: "b"}
            ]);
        }
    });

    test("observeFileEvents: observe directory recursive, open file for write, close, open another file for write, close, rename first file", async t => {
        const events = await testDirectoryEvents(async path => {
            const pathA = resolve(path, "a");
            const pathB = resolve(path, "b");
            const pathC = resolve(path, "c");
            const file = await open(pathA, "w");
            await file.close();
            const file2 = await open(pathB, "w");
            await file2.close();
            await rename(pathA, pathC);
            await rm(pathB);
        }, true);
        if (os.platform() === "win32") {
            t.deepEqual(events, [
                {event: "rename", path: "a"},
                {event: "rename", path: "b"},
                {event: "rename", path: "a"},
                {event: "rename", path: "c"},
                {event: "rename", path: "b"}
            ]);
        } else {
            // When a file is moved, renamed, or deleted, sometimes the events
            // pertaining to the file before it was moved, renamed, or deleted
            // are omitted.
            const [aEvents, otherEvents] = partition(events, event => event.path === "a");
            const [bEvents, otherEvents2] = partition(otherEvents, event => event.path === "b");
            const [cEvents, unexpectedEvents] = partition(
                otherEvents2,
                event => event.path === "c"
            );
            t.deepEqual(first(aEvents), {event: "rename", path: "a"});
            t.true(all(tail(aEvents), event => event.event === "rename"));
            t.deepEqual(first(bEvents), {event: "rename", path: "b"});
            t.deepEqual(cEvents, [{event: "rename", path: "c"}]);
            t.deepEqual(unexpectedEvents, []);
        }
    });

    test("observeFileEvents: observe directory recursive, make inner directory, open file for write in inner directory, close, move file to observed directory, delete inner directory", async t => {
        const events = await testDirectoryEvents(async path => {
            const pathA = resolve(path, "a");
            const pathB = resolve(pathA, "b");
            const pathC = resolve(path, "c");
            await mkdir(pathA);
            const file = await open(pathB, "w");
            await file.close();
            await rename(pathB, pathC);
            await rmdir(pathA);
        }, true);
        if (os.platform() === "win32") {
            // Creating a file in the watched directory sometimes, but not always,
            // generates a "change" event for the watched directory.
            const [events1, afterEvents1] = partitionWhile(events, event => event.path === "a");
            const [events2, afterEvents2] = partitionWhile(
                afterEvents1,
                event => event.path === `a${sep}b`
            );
            const [events3, otherEvents] = partitionWhile(
                afterEvents2,
                event => event.path === "a"
            );
            t.deepEqual(events1, [{event: "rename", path: "a"}]);
            t.deepEqual(events2, [{event: "rename", path: `a${sep}b`}]);
            t.true(events3.length <= 1);
            t.true(all(events3, event => event.event === "change"));
            t.deepEqual(otherEvents, [
                {event: "rename", path: `a${sep}b`},
                {event: "rename", path: "c"},
                {event: "rename", path: "a"}
            ]);
        } else {
            // When a file is moved, renamed, or deleted, sometimes the events
            // pertaining to the file before it was moved, renamed, or deleted
            // are omitted.
            const [aEvents, otherEvents] = partition(events, event => event.path === "a");
            const [bEvents, otherEvents2] = partition(
                otherEvents,
                event => event.path === `a${sep}b`
            );
            const [cEvents, unexpectedEvents] = partition(
                otherEvents2,
                event => event.path === "c"
            );
            t.deepEqual(first(aEvents), {event: "rename", path: "a"});
            t.true(all(tail(aEvents), event => event.event === "rename"));
            t.deepEqual(first(bEvents), {event: "rename", path: `a${sep}b`});
            t.true(all(tail(bEvents), event => event.event === "rename"));
            t.deepEqual(cEvents, [{event: "rename", path: "c"}]);
            t.deepEqual(unexpectedEvents, []);
        }
    });

    test("observeFileEvents: observe directory recursive, delete observed directory", async t => {
        const events = testDirectoryEvents(async path => {
            await rmdir(path);
        }, true);
        if (os.platform() === "win32") {
            await t.throwsAsync(events, {code: "EPERM"});
        } else {
            t.deepEqual(await events, []);
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

function eventNamesOnly(events: readonly FileEvent[]): WatchEventType[] {
    return events.map(({event}) => event);
}

function omitChangeAfterRename(events: readonly FileEvent[]): FileEvent[] {
    // On Linux and macOS, when observing a directory, when a file is created
    // and then written, the "rename" event is sometimes, but not always,
    // followed by a "change" event.
    return fold(
        events,
        (accumulator: FileEvent[], event) =>
            event.event === "change" &&
            last(accumulator)?.event === "rename" &&
            last(accumulator)?.path === event.path
                ? accumulator
                : [...accumulator, event],
        []
    );
}

function omitDuplicateChange(events: readonly FileEvent[]): FileEvent[] {
    // When observing a file, when the file is opened and then written, this
    // generates at least one "change" event, but sometimes more than one.
    return fold(
        events,
        (accumulator: FileEvent[], event) =>
            event.event === "change" &&
            last(accumulator)?.event === "change" &&
            last(accumulator)?.path === event.path
                ? accumulator
                : [...accumulator, event],
        []
    );
}

function omitDuplicateRename(events: readonly FileEvent[]): FileEvent[] {
    // On macOS, when observing a directory, when a new file is opened and
    // then written, this generates at least one "rename" event, but sometimes
    // more than one.
    return fold(
        events,
        (accumulator: FileEvent[], event) =>
            event.event === "rename" &&
            last(accumulator)?.event === "rename" &&
            last(accumulator)?.path === event.path
                ? accumulator
                : [...accumulator, event],
        []
    );
}

function omitRenameAfterChange(events: readonly FileEvent[]): FileEvent[] {
    // On macOS, when an existing file is opened and written, this sometimes
    // generates a "rename" event after the "change" events.
    return fold(
        events,
        (accumulator: FileEvent[], event) =>
            event.event === "rename" &&
            last(accumulator)?.event === "change" &&
            last(accumulator)?.path === event.path
                ? accumulator
                : [...accumulator, event],
        []
    );
}
