import "@testing-library/jest-dom/vitest";

// Test-only secret — never used outside the test runner.
process.env.SESSION_SECRET ??= "test-only-session-secret-do-not-use-in-production";
