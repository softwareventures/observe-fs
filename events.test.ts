import {mkdir, open, rename, rm, rmdir} from "node:fs/promises";
import * as os from "node:os";
import {basename, resolve, sep} from "node:path";
import type {WatchEventType} from "node:fs";
import {watch} from "node:fs";
import test from "ava";
import {temporaryDirectoryTask, temporaryFileTask} from "tempy";
import {EMPTY, firstValueFrom, from, of, Subject} from "rxjs";
import {delay, map, mergeMap, mergeWith, scan, switchMap, takeWhile, toArray} from "rxjs/operators";
import {
    all,
    first,
    fold,
    initial,
    last,
    partition,
    partitionWhile,
    tail,
    take
} from "@softwareventures/array";
import type {ChangeEvent, FileEvent, RenameEvent} from "./events.js";
import {observeFileEvents} from "./events.js";

// Test our assumption about fs.watch, that it will emit events for any changes
// that happen to watched files immediately after the call to fs.watch returns.
//
// This behaviour is not documented, but it is implied by the absence of any
// "ready" event.
test("fs.watch: watch file, events start emitting immediately after return", async t => {
    await temporaryFileTask(async path => {
        const file = await open(path, "w");
        await file.close();
        const abortController = new AbortController();
        const events: Array<
            | {readonly event: "Error"; readonly error: Error}
            | {readonly event: WatchEventType; readonly path: string | null}
        > = [];
        const watcher = watch(
            path,
            {signal: abortController.signal},
            (event, path) => void events.push({event, path})
        );
        watcher.addListener("error", error => void events.push({event: "Error", error}));
        // On macOS, fs.watch does not start emitting events until after an
        // arbitrary delay.
        // See https://github.com/nodejs/node/issues/52601
        if (os.platform() !== "win32" && os.platform() !== "linux") {
            await new Promise(resolve => {
                setTimeout(resolve, 200);
            });
        }
        const file2 = await open(path, "w");
        await file2.close();
        abortController.abort();
        t.deepEqual(events, [{event: "change", path: basename(path)}]);
    });
});

// Test our assumption about fs.watch, that it will emit events for any changes
// that happen to watched files immediately after the call to fs.watch returns.
//
// This behaviour is not documented, but it is implied by the absence of any
// "ready" event.
test("fs.watch: watch directory, events start emitting immediately after return", async t => {
    await temporaryDirectoryTask(async path => {
        const abortController = new AbortController();
        const events: Array<
            | {readonly event: "Error"; readonly error: Error}
            | {readonly event: WatchEventType; readonly path: string | null}
        > = [];
        const watcher = watch(
            path,
            {signal: abortController.signal},
            (event, path) => void events.push({event, path})
        );
        watcher.addListener("error", error => void events.push({event: "Error", error}));
        // On macOS, fs.watch does not start emitting events until after an
        // arbitrary delay.
        // See https://github.com/nodejs/node/issues/52601
        if (os.platform() !== "win32" && os.platform() !== "linux") {
            await new Promise(resolve => {
                setTimeout(resolve, 200);
            });
        }
        const file = await open(resolve(path, "test"), "w");
        await file.close();
        // On macOS, there is an arbitrary delay before each event.
        if (os.platform() !== "win32" && os.platform() !== "linux") {
            await new Promise(resolve => {
                setTimeout(resolve, 200);
            });
        }
        abortController.abort();
        t.deepEqual(events, [{event: "rename", path: "test"}]);
    });
});

// Recursive directory watch is unavailable on Linux
if (os.platform() !== "linux") {
    // Test our assumption about fs.watch, that it will emit events for any changes
    // that happen to watched files immediately after the call to fs.watch returns.
    //
    // This behaviour is not documented, but it is implied by the absence of any
    // "ready" event.
    test("fs.watch: watch directory recursively, events start emitting immediately after return", async t => {
        await temporaryDirectoryTask(async path => {
            const abortController = new AbortController();
            const events: Array<
                | {readonly event: "Error"; readonly error: Error}
                | {readonly event: WatchEventType; readonly path: string | null}
            > = [];
            const watcher = watch(
                path,
                {signal: abortController.signal, recursive: true},
                (event, path) => void events.push({event, path})
            );
            watcher.addListener("error", error => void events.push({event: "Error", error}));
            // On macOS, fs.watch does not start emitting events until after an
            // arbitrary delay.
            // See https://github.com/nodejs/node/issues/52601
            if (os.platform() !== "win32") {
                await new Promise(resolve => {
                    setTimeout(resolve, 200);
                });
            }
            await mkdir(resolve(path, "a"));
            const file = await open(resolve(path, "a", "b"), "w");
            await file.close();
            // On macOS, there is an arbitrary delay before each event.
            if (os.platform() !== "win32" && os.platform() !== "linux") {
                await new Promise(resolve => {
                    setTimeout(resolve, 200);
                });
            }
            abortController.abort();
            t.deepEqual(take(events, 2), [
                {event: "rename", path: "a"},
                {event: "rename", path: `a${sep}b`}
            ]);
        });
    });
}

test("observeFileEvents: file no actions", async t => {
    const {events} = await testFileEvents(async () => {});
    t.deepEqual(events, []);
});

test("observeFileEvents: open file for append and close", async t => {
    const {events} = await testFileEvents(async path => {
        const file = await open(path, "a");
        await file.close();
    });
    t.deepEqual(events, []);
});

test("observeFileEvents: open file for write and close", async t => {
    const {testFilename, events} = await testFileEvents(async path => {
        const file = await open(path, "w");
        await file.close();
    });
    t.deepEqual(events, [{event: "Change", path: testFilename}]);
});

test("observeFileEvents: open file for write, write text and close", async t => {
    const {testFilename, events} = await testFileEvents(async path => {
        const file = await open(path, "w");
        await file.write("test");
        await file.close();
    });
    if (os.platform() === "win32" || os.platform() === "linux") {
        t.deepEqual(omitDuplicateChange(events), [{event: "Change", path: testFilename}]);
    } else {
        t.deepEqual(omitDuplicateChange(omitRenameAfterChange(events)), [
            {event: "Change", path: testFilename}
        ]);
    }
});

test("observeFileEvents: open file for write, write text, close, open same file for append, write text, and close", async t => {
    const {testFilename, events} = await testFileEvents(async path => {
        const file = await open(path, "w");
        await file.write("test");
        await file.close();
        const file2 = await open(path, "a");
        await file2.write("test2");
        await file2.close();
    });

    // Expect at least two "Change" events, but possibly more.
    // When a file is opened and then written, this generates at least one
    // change event, but sometimes more than one.
    // Since we open and write the file twice, there should be at least
    // two "Change" events.
    t.deepEqual(
        fold(
            os.platform() === "win32" || os.platform() === "linux"
                ? events
                : omitRenameAfterChange(events),
            (accumulator: Array<RenameEvent | ChangeEvent>, event) =>
                event.event === "Change" &&
                last(accumulator)?.event === "Change" &&
                last(accumulator)?.path === event.path &&
                last(initial(accumulator))?.event === "Change" &&
                last(initial(accumulator))?.path === event.path
                    ? accumulator
                    : [...accumulator, event],
            []
        ),
        [
            {event: "Change", path: testFilename},
            {event: "Change", path: testFilename}
        ]
    );
});

test("observeFileEvents: rename file", async t => {
    const {testFilename, events} = await testFileEvents(async path => {
        await rename(path, `${path}_renamed`);
    });
    t.deepEqual(events, [
        {
            event: "Rename",
            path:
                os.platform() === "win32" || os.platform() === "linux"
                    ? testFilename
                    : `${testFilename}_renamed`
        }
    ]);
});

test("observeFileEvents: delete file", async t => {
    const {testFilename, events} = await testFileEvents(async path => {
        await rm(path);
    });
    t.deepEqual(
        events,
        os.platform() === "linux"
            ? [
                  {event: "Change", path: testFilename},
                  {event: "Rename", path: testFilename},
                  {event: "Rename", path: testFilename}
              ]
            : [{event: "Rename", path: testFilename}]
    );
});

test("observeFileEvents: observe directory non-recursive, no actions", async t => {
    const {events} = await testDirectoryEvents(async () => {});
    t.deepEqual(events, []);
});

test("observeFileEvents: observe directory non-recursive, open file for write and close", async t => {
    const {events} = await testDirectoryEvents(async path => {
        const file = await open(resolve(path, "a"), "w");
        await file.close();
    });
    t.deepEqual(events, [{event: "Rename", path: "a"}]);
});

test("observeFileEvents: observe directory non-recursive, open file for write, write text, and close", async t => {
    const {events} = await testDirectoryEvents(async path => {
        const file = await open(resolve(path, "a"), "w");
        await file.write("test");
        await file.close();
    });
    if (os.platform() === "win32") {
        t.deepEqual(omitDuplicateChange(events), [
            {event: "Rename", path: "a"},
            {event: "Change", path: "a"}
        ]);
    } else if (os.platform() === "linux") {
        t.deepEqual(omitChangeAfterRename(events), [{event: "Rename", path: "a"}]);
    } else {
        t.deepEqual(omitChangeAfterRename(omitRenameAfterChange(omitDuplicateRename(events))), [
            {event: "Rename", path: "a"}
        ]);
    }
});

test("observeFileEvents: observe directory non-recursive, open file for write, write text, close, open another file for write, write text, and close", async t => {
    const {events} = await testDirectoryEvents(async path => {
        const file = await open(resolve(path, "a"), "w");
        await file.write("test");
        await file.close();
        const file2 = await open(resolve(path, "b"), "w");
        await file2.write("test2");
        await file2.close();
    });
    if (os.platform() === "win32") {
        t.deepEqual(omitDuplicateChange(events), [
            {event: "Rename", path: "a"},
            {event: "Change", path: "a"},
            {event: "Rename", path: "b"},
            {event: "Change", path: "b"}
        ]);
    } else if (os.platform() === "linux") {
        t.deepEqual(omitChangeAfterRename(events), [
            {event: "Rename", path: "a"},
            {event: "Rename", path: "b"}
        ]);
    } else {
        t.deepEqual(omitChangeAfterRename(omitRenameAfterChange(omitDuplicateRename(events))), [
            {event: "Rename", path: "a"},
            {event: "Rename", path: "b"}
        ]);
    }
});

test("observeFileEvents: observe directory non-recursive, open file for write, close, open another file for write, close, rename first file", async t => {
    const {events} = await testDirectoryEvents(async path => {
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
            {event: "Rename", path: "a"},
            {event: "Rename", path: "b"},
            {event: "Rename", path: "a"},
            {event: "Rename", path: "c"},
            {event: "Rename", path: "b"}
        ]);
    } else {
        // When a file is moved, renamed, or deleted, sometimes the events
        // pertaining to the file before it was moved, renamed, or deleted
        // are omitted.
        const [aEvents, otherEvents] = partition(events, event => event.path === "a");
        const [bEvents, otherEvents2] = partition(otherEvents, event => event.path === "b");
        const [cEvents, unexpectedEvents] = partition(otherEvents2, event => event.path === "c");
        t.deepEqual(first(aEvents), {event: "Rename", path: "a"});
        t.true(all(tail(aEvents), event => event.event === "Rename"));
        t.deepEqual(first(bEvents), {event: "Rename", path: "b"});
        t.true(all(tail(bEvents), event => event.event === "Rename"));
        t.deepEqual(cEvents, [{event: "Rename", path: "c"}]);
        t.deepEqual(unexpectedEvents, []);
    }
});

test("observeFileEvents: observe directory non-recursive, make inner directory, open file for write in inner directory, close, move file to observed directory", async t => {
    const {events} = await testDirectoryEvents(async path => {
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
        // generates a "Change" event for the watched directory.
        const [aEvents, otherEvents] = partitionWhile(events, event => event.path === "a");
        t.deepEqual(first(aEvents), {event: "Rename", path: "a"});
        t.true(all(tail(aEvents), event => event.event === "Change"));
        t.deepEqual(otherEvents, [
            {event: "Rename", path: "c"},
            {event: "Rename", path: "a"}
        ]);
    } else if (os.platform() === "linux") {
        t.deepEqual(events, [
            {event: "Rename", path: "a"},
            {event: "Rename", path: "c"},
            {event: "Rename", path: "a"}
        ]);
    } else {
        // When a file is moved, renamed, or deleted, sometimes the events
        // pertaining to the file before it was moved, renamed, or deleted
        // are omitted.
        const [aEvents, otherEvents] = partition(events, event => event.path === "a");
        const [cEvents, unexpectedEvents] = partition(otherEvents, event => event.path === "c");
        t.deepEqual(first(aEvents), {event: "Rename", path: "a"});
        t.true(all(tail(aEvents), event => event.event === "Rename"));
        t.deepEqual(cEvents, [{event: "Rename", path: "c"}]);
        t.deepEqual(unexpectedEvents, []);
    }
});

test("observeFileEvents: observe directory non-recursive, delete observed directory", async t => {
    const result = testDirectoryEvents(async path => {
        await rmdir(path);
    });
    if (os.platform() === "win32") {
        await t.throwsAsync(result, {code: "EPERM"});
    } else if (os.platform() === "linux") {
        // The "path" field in both events will be the name of the directory we are watching.
        const {testFilename, events} = await result;
        t.deepEqual(events, [
            {event: "Rename", path: testFilename},
            {event: "Rename", path: testFilename}
        ]);
    } else {
        const {events} = await result;
        t.deepEqual(events, []);
    }
});

// Recursive directory observation is unavailable on Linux
if (os.platform() !== "linux") {
    test("observeFileEvents: observe directory recursive, no actions", async t => {
        const {events} = await testDirectoryEvents(async () => {}, true);
        t.deepEqual(events, []);
    });

    test("observeFileEvents: observe directory recursive, open file for write and close", async t => {
        const {events} = await testDirectoryEvents(async path => {
            const file = await open(resolve(path, "a"), "w");
            await file.close();
        }, true);
        t.deepEqual(events, [{event: "Rename", path: "a"}]);
    });

    test("observeFileEvents: observe directory recursive, open file for write, write text, and close", async t => {
        const {events} = await testDirectoryEvents(async path => {
            const file = await open(resolve(path, "a"), "w");
            await file.write("test");
            await file.close();
        }, true);
        if (os.platform() === "win32") {
            t.deepEqual(omitDuplicateChange(events), [
                {event: "Rename", path: "a"},
                {event: "Change", path: "a"}
            ]);
        } else {
            t.deepEqual(omitChangeAfterRename(omitRenameAfterChange(omitDuplicateRename(events))), [
                {event: "Rename", path: "a"}
            ]);
        }
    });

    test("observeFileEvents: observe directory recursive, open file for write, write text, close, open another file for write, write text, close", async t => {
        const {events} = await testDirectoryEvents(async path => {
            const file = await open(resolve(path, "a"), "w");
            await file.write("test");
            await file.close();
            const file2 = await open(resolve(path, "b"), "w");
            await file2.write("test2");
            await file2.close();
        }, true);
        if (os.platform() === "win32") {
            t.deepEqual(omitDuplicateChange(events), [
                {event: "Rename", path: "a"},
                {event: "Change", path: "a"},
                {event: "Rename", path: "b"},
                {event: "Change", path: "b"}
            ]);
        } else {
            t.deepEqual(omitChangeAfterRename(omitRenameAfterChange(omitDuplicateRename(events))), [
                {event: "Rename", path: "a"},
                {event: "Rename", path: "b"}
            ]);
        }
    });

    test("observeFileEvents: observe directory recursive, open file for write, close, open another file for write, close, rename first file", async t => {
        const {events} = await testDirectoryEvents(async path => {
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
                {event: "Rename", path: "a"},
                {event: "Rename", path: "b"},
                {event: "Rename", path: "a"},
                {event: "Rename", path: "c"},
                {event: "Rename", path: "b"}
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
            t.deepEqual(first(aEvents), {event: "Rename", path: "a"});
            t.true(all(tail(aEvents), event => event.event === "Rename"));
            t.deepEqual(first(bEvents), {event: "Rename", path: "b"});
            t.deepEqual(cEvents, [{event: "Rename", path: "c"}]);
            t.deepEqual(unexpectedEvents, []);
        }
    });

    test("observeFileEvents: observe directory recursive, make inner directory, open file for write in inner directory, close, move file to observed directory, delete inner directory", async t => {
        const {events} = await testDirectoryEvents(async path => {
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
            // Creating or deleting a file in the watched directory sometimes,
            // but not always, generates a "Change" event for the watched directory.
            const [events1, afterEvents1] = partitionWhile(events, event => event.path === "a");
            const [events2, afterEvents2] = partitionWhile(
                afterEvents1,
                event => event.path === `a${sep}b`
            );
            const [events3, afterEvents3] = partitionWhile(
                afterEvents2,
                event => event.path === "a"
            );
            const [events4, afterEvents4] = partitionWhile(
                afterEvents3,
                event => event.path === `a${sep}b`
            );
            const [events5, afterEvents5] = partitionWhile(
                afterEvents4,
                event => event.path === "a"
            );
            const [events6, otherEvents] = partitionWhile(
                afterEvents5,
                event => event.path === "c"
            );
            t.deepEqual(events1, [{event: "Rename", path: "a"}]);
            t.deepEqual(events2, [{event: "Rename", path: `a${sep}b`}]);
            t.true(events3.length <= 1);
            t.true(all(events3, event => event.event === "Change"));
            t.deepEqual(events4, [{event: "Rename", path: `a${sep}b`}]);
            t.true(events5.length <= 1);
            t.true(all(events5, event => event.event === "Change"));
            t.deepEqual(events6, [{event: "Rename", path: "c"}]);
            if (otherEvents.length === 1) {
                t.deepEqual(otherEvents, [{event: "Rename", path: "a"}]);
            } else {
                t.deepEqual(otherEvents, [
                    {event: "Change", path: "a"},
                    {event: "Rename", path: "a"}
                ]);
            }
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
            t.deepEqual(first(aEvents), {event: "Rename", path: "a"});
            t.true(all(tail(aEvents), event => event.event === "Rename"));
            t.deepEqual(first(bEvents), {event: "Rename", path: `a${sep}b`});
            t.true(all(tail(bEvents), event => event.event === "Rename"));
            t.deepEqual(cEvents, [{event: "Rename", path: "c"}]);
            t.deepEqual(unexpectedEvents, []);
        }
    });

    test("observeFileEvents: observe directory recursive, delete observed directory", async t => {
        const result = testDirectoryEvents(async path => {
            await rmdir(path);
        }, true);
        if (os.platform() === "win32") {
            await t.throwsAsync(result, {code: "EPERM"});
        } else {
            const {events} = await result;
            t.deepEqual(events, []);
        }
    });
}

test("observeFileEvents: first event is Ready", async t => {
    await temporaryFileTask(async path => {
        const writeFile = async (): Promise<void> => {
            const file = await open(path, "w");
            await file.close();
        };

        await writeFile();

        const interval = setInterval(() => void writeFile(), 10);

        const events = await firstValueFrom(
            observeFileEvents(path).pipe(
                mergeMap(event => {
                    clearInterval(interval);
                    return of(event).pipe(
                        mergeWith(
                            from(writeFile()).pipe(
                                map(() => ({event: "Done"}) as const),
                                delay(
                                    os.platform() === "win32" || os.platform() === "linux"
                                        ? 20
                                        : 200
                                )
                            )
                        )
                    );
                }),
                takeWhile(({event}) => event !== "Done"),
                toArray()
            )
        );

        t.true(events.length > 1);
        t.deepEqual(events[0], {event: "Ready"});
        t.true(all(initial(tail(events)), ({event}) => event !== "Ready" && event !== "Done"));
    });
});

interface TestEventsResult {
    readonly testFilename: string;
    readonly events: ReadonlyArray<RenameEvent | ChangeEvent>;
}

async function testFileEvents(actions: (path: string) => Promise<void>): Promise<TestEventsResult> {
    return temporaryFileTask(async path => {
        const file = await open(path, "w");
        await file.close();

        const events = await testEventsInternal({path, actions});
        return {testFilename: basename(path), events};
    });
}

async function testDirectoryEvents(
    actions: (path: string) => Promise<void>,
    recursive = false
): Promise<TestEventsResult> {
    return temporaryDirectoryTask(async path => {
        const events = await testEventsInternal({path, actions, recursive});
        return {testFilename: basename(path), events};
    });
}

interface TestEventsInternalOptions {
    readonly path: string;
    readonly actions: (path: string) => Promise<void>;
    readonly recursive?: boolean | undefined;
}

async function testEventsInternal({
    path,
    actions,
    recursive = false
}: TestEventsInternalOptions): Promise<Array<RenameEvent | ChangeEvent>> {
    const doneEvents = new Subject<"Done">();

    return firstValueFrom(
        observeFileEvents({path, recursive}).pipe(
            mergeWith(doneEvents),
            scan(
                (
                    {
                        state
                    }: {readonly event: FileEvent | "Done"; readonly state: "Active" | "Done"},
                    event
                ) => ({
                    event,
                    state: event === "Done" ? "Done" : state
                }),
                {event: {event: "Ready"}, state: "Active"}
            ),
            switchMap(({event, state}) =>
                (event === "Done" ? EMPTY : of(event)).pipe(
                    mergeWith(
                        state === "Done"
                            ? of({event: "Done"} as const).pipe(
                                  delay(
                                      os.platform() === "win32" || os.platform() === "linux"
                                          ? 20
                                          : 400
                                  )
                              )
                            : EMPTY
                    )
                )
            ),
            takeWhile(({event}) => event !== "Done"),
            mergeMap(event => {
                if (event.event === "Ready") {
                    return of(actions(path).then(() => void doneEvents.next("Done"))).pipe(
                        mergeMap(() => EMPTY)
                    );
                } else if (event.event === "Done") {
                    return EMPTY;
                } else {
                    return of(event);
                }
            }),
            toArray()
        )
    );
}

function omitChangeAfterRename(
    events: ReadonlyArray<RenameEvent | ChangeEvent>
): Array<RenameEvent | ChangeEvent> {
    // On Linux and macOS, when observing a directory, when a file is created
    // and then written, the "Rename" event is sometimes, but not always,
    // followed by a "Change" event.
    return fold(
        events,
        (accumulator: Array<RenameEvent | ChangeEvent>, event) =>
            event.event === "Change" &&
            last(accumulator)?.event === "Rename" &&
            last(accumulator)?.path === event.path
                ? accumulator
                : [...accumulator, event],
        []
    );
}

function omitDuplicateChange(
    events: ReadonlyArray<RenameEvent | ChangeEvent>
): Array<RenameEvent | ChangeEvent> {
    // When observing a file, when the file is opened and then written, this
    // generates at least one "Change" event, but sometimes more than one.
    return fold(
        events,
        (accumulator: Array<RenameEvent | ChangeEvent>, event) =>
            event.event === "Change" &&
            last(accumulator)?.event === "Change" &&
            last(accumulator)?.path === event.path
                ? accumulator
                : [...accumulator, event],
        []
    );
}

function omitDuplicateRename(
    events: ReadonlyArray<RenameEvent | ChangeEvent>
): Array<RenameEvent | ChangeEvent> {
    // On macOS, when observing a directory, when a new file is opened and
    // then written, this generates at least one "Rename" event, but sometimes
    // more than one.
    return fold(
        events,
        (accumulator: Array<RenameEvent | ChangeEvent>, event) =>
            event.event === "Rename" &&
            last(accumulator)?.event === "Rename" &&
            last(accumulator)?.path === event.path
                ? accumulator
                : [...accumulator, event],
        []
    );
}

function omitRenameAfterChange(
    events: ReadonlyArray<RenameEvent | ChangeEvent>
): Array<RenameEvent | ChangeEvent> {
    // On macOS, when an existing file is opened and written, this sometimes
    // generates a "Rename" event after the "Change" events.
    return fold(
        events,
        (accumulator: Array<RenameEvent | ChangeEvent>, event) =>
            event.event === "Rename" &&
            last(accumulator)?.event === "Change" &&
            last(accumulator)?.path === event.path
                ? accumulator
                : [...accumulator, event],
        []
    );
}
