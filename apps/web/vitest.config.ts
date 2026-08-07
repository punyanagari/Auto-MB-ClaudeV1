import { defineConfig } from 'vitest/config';

// passWithNoTests is a deliberate, temporary exception: the web shell is a
// static status page with no behaviour worth unit-testing yet. Remove the
// flag with the first real UI workflow (Milestone 1 organisation
// selection), when going green without tests would hide a missing suite.
export default defineConfig({
  test: {
    environment: 'node',
    passWithNoTests: true,
  },
});
