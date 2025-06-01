# Fix for Issue #62: Don't use async methods in sync handlers

## Problem

The original code in `src/logical-replication-service.ts` had two problematic patterns with async methods in sync handlers:

### 1. Async callback in setInterval

An async function was passed as a callback to `setInterval`:

```typescript
this.checkStandbyStatusTimer = setInterval(async () => {
  if (this._stop) return;
  if (
    this._lastLsn &&
    Date.now() - this.lastStandbyStatusUpdatedTime > this.config.acknowledge!.timeoutSeconds * 1000
  )
    await this.acknowledge(this._lastLsn);
}, 1000);
```

### 2. Unhandled async call in event handler

The `_acknowledge` method was called without proper error handling in the `copyData` event handler:

```typescript
if (buffer[0] == 0x77) {
  // XLogData
  this.emit('data', lsn, plugin.parse(buffer.subarray(25)));
  this._acknowledge(lsn); // async method called without await or .catch()
}
```

## Issues with this approach

1. **Unhandled Promise Rejections**: If the `acknowledge()` method throws an error, it would result in an unhandled promise rejection, which can cause the Node.js process to crash in newer versions.

2. **Memory Leaks**: Async functions return promises, and if these promises are not properly handled, they can accumulate in memory.

3. **Unpredictable Timing**: The timer interval doesn't account for the time it takes for the async operation to complete, which could lead to overlapping executions.

## Solution

### 1. Fixed setInterval callback

The fix changes the callback to a synchronous function and properly handles the promise returned by `acknowledge()`:

```typescript
this.checkStandbyStatusTimer = setInterval(() => {
  if (this._stop) return;

  if (
    this._lastLsn &&
    Date.now() - this.lastStandbyStatusUpdatedTime > this.config.acknowledge!.timeoutSeconds * 1000
  ) {
    this.acknowledge(this._lastLsn).catch((error) => {
      this.emit('error', error);
    });
  }
}, 1000);
```

### 2. Fixed event handler async call

The `_acknowledge` call now properly handles promise rejections:

```typescript
if (buffer[0] == 0x77) {
  // XLogData
  this.emit('data', lsn, plugin.parse(buffer.subarray(25)));
  this._acknowledge(lsn).catch((error) => {
    this.emit('error', error);
  });
}
```

## Benefits of this approach

1. **Proper Error Handling**: Any errors from the `acknowledge()` method are caught and emitted as error events, which can be handled by the application.

2. **No Unhandled Rejections**: The promise is explicitly handled with a `.catch()` block.

3. **Consistent with Event-Driven Architecture**: Errors are emitted as events, which is consistent with the EventEmitter2 pattern used throughout the class.

4. **Non-blocking**: The timer continues to run even if one acknowledgment fails.

## Testing

A comprehensive test suite has been added in `src/test/async-handler-fix.spec.ts` that verifies:

1. Errors in the acknowledge method are properly caught and emitted as error events
2. No unhandled promise rejections occur
3. The timer continues to work normally when acknowledge succeeds
4. The fix doesn't break existing functionality

## Backward Compatibility

This fix is fully backward compatible. The public API remains unchanged, and the behavior is the same except for improved error handling.
