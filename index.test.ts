import {open, rename, rm} from "node:fs/promises";
import test from "ava";
import {temporaryFileTask} from "tempy";
import {filter, BehaviorSubject, EMPTY, firstValueFrom, interval, of} from "rxjs";
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
import type {FileEvent} from "./index.js";
import {observeFileEvents} from "./index.js";
import * as os from "os";

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
        ["change", "change", "change"]
    );
    t.deepEqual(
        (
            await testFileObservable(async path => {
                await rename(path, `${path}_renamed`);
            })
        ).map(({event}) => event),
        os.platform() === "win32" ? ["rename"] : ["change", "rename", "rename"]
    );
    t.deepEqual(
        (
            await testFileObservable(async path => {
                await rm(path);
            })
        ).map(({event}) => event),
        ["rename"]
    );
});

type TestFileState = "Init" | "SeenSentinel" | "Ready" | "Done";

async function testFileObservable(actions: (path: string) => Promise<void>): Promise<FileEvent[]> {
    return temporaryFileTask(async path => {
        const stateEvents = new BehaviorSubject<TestFileState>("Init");
        const fileEvents = observeFileEvents(path);
        const requestSentinel = interval(10).pipe(map(() => "RequestSentinel" as const));

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
                    mergeWith(stateEvents, fileEvents),
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
                                          delay(20)
                                      )
                                    : EMPTY
                            )
                        )
                    ),
                    mergeMap(({event, state}) =>
                        event === "Done"
                            ? of({event, state}).pipe(delay(20))
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
                            void actions(path).then(() => void stateEvents.next("Done"));
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
