<?php

declare(strict_types=1);

namespace RecoverX\Licensing;

/**
 * Structured request log: one JSON object per line, in the private data
 * directory (`data/logs/licensing-YYYY-MM.log`, a new file each month so no
 * single file grows without bound).
 *
 * The lines have the reference server's shape — `time`, `level`, `msg`, then
 * the fields — so the same tools read both. Two things never appear in them,
 * and the call sites are responsible for that: a full licence key (use
 * `Authority::logSafeKey`) and any token, activation or admin.
 */
final class Logger
{
    /** @var callable(): int */
    private $clock;

    /** @param null|callable(): int $clock */
    public function __construct(private readonly ?string $directory, ?callable $clock = null)
    {
        $this->clock = $clock ?? Authority::systemClock(...);
    }

    /** A logger that discards everything. */
    public static function silent(): self
    {
        return new self(null);
    }

    /** @param array<string, mixed> $fields */
    public function info(string $message, array $fields = []): void
    {
        $this->emit('info', $message, $fields);
    }

    /** @param array<string, mixed> $fields */
    public function warn(string $message, array $fields = []): void
    {
        $this->emit('warn', $message, $fields);
    }

    /** @param array<string, mixed> $fields */
    public function error(string $message, array $fields = []): void
    {
        $this->emit('error', $message, $fields);
    }

    /** The file this month's lines go to, or `null` for a silent logger. */
    public function currentFile(): ?string
    {
        if ($this->directory === null) {
            return null;
        }

        $seconds = intdiv(($this->clock)(), 1000);

        return $this->directory . '/licensing-' . gmdate('Y-m', $seconds) . '.log';
    }

    /**
     * A thrown error as a log field: class, message and where, plus a
     * compact trace of function names and lines. Never the arguments, which
     * may be a key, a token or a password.
     *
     * @return array<string, mixed>
     */
    public static function describe(\Throwable $error): array
    {
        $frames = [];
        foreach (array_slice($error->getTrace(), 0, 12) as $frame) {
            $function = ($frame['class'] ?? '') . ($frame['type'] ?? '') . $frame['function'];
            $where = isset($frame['file']) ? basename($frame['file']) . ':' . ($frame['line'] ?? '?') : '';
            $frames[] = trim("{$function} {$where}");
        }

        return [
            'name' => $error::class,
            'message' => $error->getMessage(),
            'at' => basename($error->getFile()) . ':' . $error->getLine(),
            'trace' => $frames,
            'cause' => $error->getPrevious() === null ? null : self::describe($error->getPrevious()),
        ];
    }

    /** @param array<string, mixed> $fields */
    private function emit(string $level, string $message, array $fields): void
    {
        $file = $this->currentFile();
        if ($file === null) {
            return;
        }

        $now = ($this->clock)();
        $time = gmdate('Y-m-d\TH:i:s', intdiv($now, 1000)) . sprintf('.%03dZ', $now % 1000);

        foreach ($fields as $name => $value) {
            if ($value instanceof \Throwable) {
                $fields[$name] = self::describe($value);
            }
        }

        $record = ['time' => $time, 'level' => $level, 'msg' => $message] + $fields;
        $line = json_encode($record, TokenSigner::JSON_FLAGS | JSON_INVALID_UTF8_SUBSTITUTE | JSON_PARTIAL_OUTPUT_ON_ERROR);
        if ($line === false) {
            $line = json_encode(['time' => $time, 'level' => $level, 'msg' => $message, 'logError' => 'unserialisable']);
        }

        // A log that cannot be written must never take a request down with it.
        if (!is_dir($this->directory)) {
            @mkdir($this->directory, 0700, true);
        }
        @file_put_contents($file, $line . "\n", FILE_APPEND | LOCK_EX);
    }
}
