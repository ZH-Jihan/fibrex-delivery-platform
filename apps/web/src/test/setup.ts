// Test setup: jest-dom matchers and cleanup between tests.
import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// findBy*/waitFor wait 1 s by default, which is too short when the whole suite runs in
// parallel; they return as soon as the element appears, so passing tests stay as fast.
configure({ asyncUtilTimeout: 10000 });

afterEach(() => {
  cleanup();
});
