export function configuration(env = process.env) {
  const number = (key, fallback, max) => {
    const value = Number(env[key] ?? fallback);
    if (!Number.isInteger(value) || value < 1 || value > max)
      throw new Error(`Invalid ${key}`);
    return value;
  };
  if (!env.COMPUTER_SECRET || env.COMPUTER_SECRET.length < 32)
    throw new Error("COMPUTER_SECRET must contain at least 32 characters");
  return {
    secret: env.COMPUTER_SECRET,
    browserExecutable: env.COMPUTER_BROWSER_EXECUTABLE || "",
    shellURL: env.COMPUTER_SHELL_URL || '',
    profileBackend: env.COMPUTER_PROFILE_BACKEND || '',
    profileStorageHost: env.COMPUTER_PROFILE_STORAGE_HOST || '',
    sshBackend: env.COMPUTER_SSH_BACKEND || '',
    librarySecret: env.LIBRARY_BUILDER_SECRET || "",
    magickSecret: env.MAGICK_SECRET || "",
    host: env.COMPUTER_HOST || "127.0.0.1",
    port: number("COMPUTER_PORT", 3002, 65535),
    sessions: number("COMPUTER_MAX_SESSIONS", 16, 128),
    perUser: number("COMPUTER_MAX_PER_USER", 4, 32),
    perOwner: number("COMPUTER_MAX_PER_APP_USER", 2, 16),
    tabs: number("COMPUTER_MAX_TABS", 8, 32),
    actions: number("COMPUTER_MAX_ACTIONS", 8, 64),
    timeout: number("COMPUTER_ACTION_TIMEOUT_MS", 20_000, 60_000),
    workTimeout: number("COMPUTER_WORK_TIMEOUT_MS", 60_000, 60_000),
    workRoot: env.COMPUTER_WORK_ROOT || '',
    idle: number("COMPUTER_IDLE_MS", 180_000, 900_000),
    lifetime: number("COMPUTER_LIFETIME_MS", 900_000, 3_600_000),
  };
}
