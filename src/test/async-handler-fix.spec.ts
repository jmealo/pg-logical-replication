import { LogicalReplicationService } from '../logical-replication-service.js';
import { Wal2JsonPlugin } from '../output-plugins/wal2json/wal2json-plugin.js';
import { TestClientConfig } from './client-config.js';
import { sleep, TestClient } from './test-common.js';

jest.setTimeout(30000);
const [slotName, decoderName] = ['slot_async_handler_fix', 'wal2json'];

let client: TestClient;
describe('async handler fix', () => {
  beforeAll(async () => {
    client = await TestClient.New(slotName, decoderName);
  });

  afterAll(async () => {
    await client.end();
  });

  it('should handle errors in setInterval callback without causing unhandled rejections', async () => {
    const service = new LogicalReplicationService(TestClientConfig, {
      acknowledge: { auto: false, timeoutSeconds: 1 }, // Short timeout for testing
    });
    const plugin = new Wal2JsonPlugin({});

    let errorEmitted = false;
    let unhandledRejection = false;

    // Listen for error events
    service.on('error', (error) => {
      console.log('Error event emitted:', error.message);
      errorEmitted = true;
    });

    // Listen for unhandled promise rejections
    const unhandledRejectionHandler = (reason: any) => {
      console.log('Unhandled rejection:', reason);
      unhandledRejection = true;
    };
    process.on('unhandledRejection', unhandledRejectionHandler);

    // Mock the acknowledge method to throw an error
    const originalAcknowledge = service.acknowledge.bind(service);
    service.acknowledge = jest.fn().mockRejectedValue(new Error('Test acknowledge error'));

    try {
      // Start the service
      await service.subscribe(plugin, slotName);
      await sleep(100);

      // Insert some data to trigger replication
      const insertQuery = `INSERT INTO users(firstname, lastname, email, phone)
         SELECT 'test', 'user', 'test@example.com', '123-456-7890'
         FROM generate_series(1, 1) RETURNING *`;
      
      await client.query(insertQuery);
      await sleep(100);

      // Wait for the timer to trigger (timeout is 1 second)
      await sleep(2000);

      // Verify that errors are properly handled
      expect(errorEmitted).toBe(true);
      expect(unhandledRejection).toBe(false);

    } finally {
      // Cleanup
      process.removeListener('unhandledRejection', unhandledRejectionHandler);
      await service.stop();
    }
  });

  it('should work normally when acknowledge succeeds', async () => {
    const service = new LogicalReplicationService(TestClientConfig, {
      acknowledge: { auto: false, timeoutSeconds: 1 }, // Short timeout for testing
    });
    const plugin = new Wal2JsonPlugin({});

    let errorEmitted = false;
    let acknowledgeCallCount = 0;

    // Listen for error events
    service.on('error', (error) => {
      console.log('Unexpected error:', error.message);
      errorEmitted = true;
    });

    // Mock the acknowledge method to succeed and count calls
    service.acknowledge = jest.fn().mockImplementation(async (lsn: string) => {
      acknowledgeCallCount++;
      console.log(`Acknowledge called ${acknowledgeCallCount} times for LSN: ${lsn}`);
      return true;
    });

    try {
      // Start the service
      await service.subscribe(plugin, slotName);
      await sleep(100);

      // Insert some data to trigger replication
      const insertQuery = `INSERT INTO users(firstname, lastname, email, phone)
         SELECT 'test2', 'user2', 'test2@example.com', '123-456-7891'
         FROM generate_series(1, 1) RETURNING *`;
      
      await client.query(insertQuery);
      await sleep(100);

      // Wait for the timer to trigger multiple times
      await sleep(3000);

      // Verify that acknowledge was called and no errors occurred
      expect(acknowledgeCallCount).toBeGreaterThan(0);
      expect(errorEmitted).toBe(false);

    } finally {
      await service.stop();
    }
  });
});
