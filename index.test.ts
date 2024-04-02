import {open, rename, rm} from "node:fs/promises";
import * as os from "node:os";
import test from "ava";
import {temporaryFileTask} from "tempy";
import {filter, BehaviorSubject, EMPTY, firstValueFrom, interval, of, Subject} from "rxjs";
import {
    concatWith,
    delay,
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

type TestFileState = "Init" | "SeenSentinel" | "Ready" | "Done";

async function testFileObservable(actions: (path: string) => Promise<void>): Promise<FileEvent[]> {
    return temporaryFileTask(async path => {
        const stateEvents = new BehaviorSubject<TestFileState>("Init");
        const errorEvents = new Subject<unknown>();
        const fileEvents = observeFileEvents(path);
        const requestSentinel = interval(1).pipe(map(() => "RequestSentinel" as const));

        const writeEmptyFile = async (): Promise<void> => {
            const file = await open(path, "w");
            await file.write("");
            await file.close();
        };

        await writeEmptyFile();

        return firstValueFrom(
            requestSentinel
                .pipe(
                    takeUntil(stateEvents.pipe(filter(state => state === "SeenSentinel"))),
                    mergeWith(
                        stateEvents,
                        fileEvents,
                        errorEvents.pipe(
                            map(reason => {
                                throw reason;
                            })
                        )
                    ),
                    scan(
                        (
                            previous: {
                                readonly state: TestFileState;
                                readonly event: FileEvent | TestFileState | "RequestSentinel";
                            },
                            event
                        ) =>
                            ({
                                event,
                                state:
                                    event === "SeenSentinel" ||
                                    event === "Ready" ||
                                    event === "Done"
                                        ? event
                                        : previous.state
                            }) as const,
                        {event: "Init", state: "Init"}
                    ),
                    switchMap(({event, state}) =>
                        of({event, state}).pipe(
                            concatWith(
                                event === "SeenSentinel"
                                    ? of({event: "DelayAfterSeenSentinel", state} as const).pipe(
                                          delay(2)
                                      )
                                    : EMPTY
                            )
                        )
                    ),
                    mergeMap(({event, state}) =>
                        event === "Done"
                            ? of({event, state}).pipe(delay(4))
                            : of({
                                  event,
                                  state
                              })
                    ),
                    tap(({event, state}) => {
                        if (event === "RequestSentinel") {
                            if (state === "Init") {
                                void writeEmptyFile();
                            }
                        } else if (event === "DelayAfterSeenSentinel") {
                            if (state === "Init" || state === "SeenSentinel") {
                                stateEvents.next("Ready");
                            }
                        } else if (event === "Ready") {
                            void actions(path).then(
                                () => void stateEvents.next("Done"),
                                reason => void errorEvents.next(reason)
                            );
                        } else if (
                            typeof event === "object" &&
                            (state === "Init" || state === "SeenSentinel")
                        ) {
                            stateEvents.next("SeenSentinel");
                        }
                    }),
                    skipWhile(({event}) => event !== "Ready"),
                    takeWhile(({event}) => event !== "Done"),
                    mergeMap(({event}) => (typeof event === "object" ? of(event) : EMPTY))
                )
                .pipe(toArray())
        );
    });
}
