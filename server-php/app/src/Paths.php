<?php

declare(strict_types=1);

namespace RecoverX\Licensing;

/**
 * Where everything lives, derived from the location of the `app/` folder.
 *
 * On Hostinger the layout is:
 *
 *     ~/domains/recoverx.snapkio.com/
 *       public_html/                  ← the website, plus v1/, admin/, setup/ and .htaccess
 *       recoverx-licensing/           ← NOT web-accessible
 *         app/                        ← this code
 *         data/                       ← created by /setup/: key, config, database, logs, sessions
 *         config.local.php            ← optional overrides (see README)
 *
 * Nothing here names the hosting account, so the same files work in any
 * home directory, and in the throwaway trees the tests build.
 */
final class Paths
{
    public function __construct(
        public readonly string $appDir,
        public readonly string $installDir,
        public readonly string $dataDir,
    ) {
    }

    /**
     * Derive the paths from the app folder, honouring a `data_dir` set in the
     * optional `config.local.php` next to it.
     */
    public static function detect(string $appDir): self
    {
        $appDir = rtrim(str_replace('\\', '/', $appDir), '/');
        $installDir = dirname($appDir);
        $local = self::readLocalConfig($installDir . '/config.local.php');

        $dataDir = $installDir . '/data';
        if (isset($local['data_dir']) && is_string($local['data_dir']) && $local['data_dir'] !== '') {
            $dataDir = rtrim(str_replace('\\', '/', $local['data_dir']), '/');
        }

        return new self($appDir, $installDir, $dataDir);
    }

    /**
     * The optional overrides file, or an empty array.
     *
     * @return array<string, mixed>
     */
    public static function readLocalConfig(string $file): array
    {
        if (!is_file($file)) {
            return [];
        }

        $values = (static fn (string $path): mixed => include $path)($file);

        if (!is_array($values)) {
            throw new ConfigError("{$file} must return an array, for example: <?php return ['trust_proxy' => true];");
        }

        return $values;
    }

    public function localConfigFile(): string
    {
        return $this->installDir . '/config.local.php';
    }

    public function configFile(): string
    {
        return $this->dataDir . '/config.php';
    }

    public function signingKeyFile(): string
    {
        return $this->dataDir . '/signing.key';
    }

    public function databaseFile(): string
    {
        return $this->dataDir . '/licences.db';
    }

    public function lockFile(): string
    {
        return $this->dataDir . '/setup.lock';
    }

    public function setupCodeFile(): string
    {
        return $this->dataDir . '/setup-code.txt';
    }

    public function logDir(): string
    {
        return $this->dataDir . '/logs';
    }

    public function sessionDir(): string
    {
        return $this->dataDir . '/sessions';
    }

    public function tmpDir(): string
    {
        return $this->dataDir . '/tmp';
    }

    /**
     * Whether `$path` is inside the web server's document root — where a
     * misconfigured server could hand it to anyone who asks.
     */
    public static function isInside(string $path, ?string $root): bool
    {
        if ($root === null || $root === '') {
            return false;
        }

        $normalise = static function (string $value): string {
            $real = realpath($value);
            $text = str_replace('\\', '/', $real === false ? $value : $real);

            return rtrim(PHP_OS_FAMILY === 'Windows' ? strtolower($text) : $text, '/') . '/';
        };

        return str_starts_with($normalise($path), $normalise($root));
    }

    /** The names hosts give the folder a website is served from. */
    public const WEB_FOLDER_NAMES = ['public_html', 'htdocs', 'httpdocs', 'wwwroot'];

    /**
     * The nearest folder at or above `$path` named like a website's folder
     * (`public_html` and its kin), or `null`.
     *
     * Comparing with this request's document root is not enough. A subdomain
     * whose folder was made inside the main site's `public_html` — hPanel's
     * default for a subdomain — has its own document root, but the program
     * and its data, one level above that root as the entry points expect,
     * land inside the main site's `public_html`, where the main site serves
     * them.
     */
    public static function webFolderAbove(string $path): ?string
    {
        $real = realpath($path);
        $current = rtrim(str_replace('\\', '/', $real === false ? $path : $real), '/');

        while ($current !== '') {
            if (in_array(strtolower(basename($current)), self::WEB_FOLDER_NAMES, true)) {
                return $current;
            }

            $parent = str_replace('\\', '/', dirname($current));
            if ($parent === $current || $parent === '.') {
                return null;
            }
            $current = rtrim($parent, '/');
        }

        return null;
    }
}
