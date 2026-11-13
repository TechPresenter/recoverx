<?php

declare(strict_types=1);

namespace RecoverX\Licensing;

/** File-system helpers for the private data directory. */
final class Files
{
    private function __construct()
    {
    }

    /**
     * Replace a file's contents in one step: write a temporary file beside it,
     * set its permissions, then rename it over the original. A reader sees the
     * old file or the new one, never half of either.
     */
    public static function writeAtomically(string $file, #[\SensitiveParameter] string $contents, int $mode = 0600): void
    {
        $directory = dirname($file);
        $temporary = $directory . '/.' . basename($file) . '.' . bin2hex(random_bytes(6)) . '.tmp';

        if (@file_put_contents($temporary, $contents, LOCK_EX) !== strlen($contents)) {
            @unlink($temporary);
            throw new \RuntimeException("Could not write {$file}. Check that the folder {$directory} is writable.");
        }

        @chmod($temporary, $mode);

        if (!@rename($temporary, $file)) {
            // Windows will not rename over an existing file that is open; the
            // copy-and-delete fallback is not atomic, but only local
            // development runs there.
            if (!@copy($temporary, $file)) {
                @unlink($temporary);
                throw new \RuntimeException("Could not replace {$file}.");
            }
            @unlink($temporary);
            @chmod($file, $mode);
        }
    }

    /**
     * Create a private directory (owner-only) if it does not exist, with a
     * deny-all `.htaccess` as a second layer in case it ever ends up under a
     * web root.
     */
    public static function ensurePrivateDirectory(string $directory): void
    {
        if (!is_dir($directory) && !@mkdir($directory, 0700, true) && !is_dir($directory)) {
            throw new \RuntimeException("Could not create the folder {$directory}. Check that its parent folder is writable.");
        }

        @chmod($directory, 0700);

        $htaccess = $directory . '/.htaccess';
        if (!is_file($htaccess)) {
            @file_put_contents($htaccess, self::DENY_ALL);
        }

        $index = $directory . '/index.html';
        if (!is_file($index)) {
            @file_put_contents($index, '');
        }
    }

    public const DENY_ALL = <<<'HTACCESS'
        # Private data of the RecoverX licence server. Never served.
        <IfModule mod_authz_core.c>
          Require all denied
        </IfModule>
        <IfModule !mod_authz_core.c>
          Order allow,deny
          Deny from all
        </IfModule>

        HTACCESS;
}
