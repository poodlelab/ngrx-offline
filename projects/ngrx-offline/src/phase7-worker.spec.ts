// Keep worker implementation tests next to the worker entry point while making
// them discoverable by the Angular library test target.
import { workerOutboxExecutorTests } from '../worker/src/lib/worker-outbox-executor.spec';

workerOutboxExecutorTests();
