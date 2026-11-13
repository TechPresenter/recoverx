<?php

declare(strict_types=1);

namespace RecoverX\Licensing\Web;

use RecoverX\Licensing\Files;
use RecoverX\Licensing\Http\Request;
use RecoverX\Licensing\Paths;

/**
 * PHP sessions for the admin panel and the setup page, hardened.
 *
 * Session files live in the private data folder, not the host's shared
 * temporary directory. The cookie is HttpOnly, SameSite=Strict, Secure on
 * HTTPS, and scoped to the one path that uses it. Strict mode refuses a
 * session id the server did not issue (session fixation), and every form
 * carries a CSRF token tied to the session.
 */
final class Session
{
    private function __construct()
    {
    }

    public static function start(Paths $paths, Request $request, string $name, string $path, int $lifetimeSeconds): void
    {
        if (session_status() === PHP_SESSION_ACTIVE) {
            return;
        }

        Files::ensurePrivateDirectory($paths->sessionDir());
        session_save_path($paths->sessionDir());
        session_name($name);

        ini_set('session.use_strict_mode', '1');
        ini_set('session.use_cookies', '1');
        ini_set('session.cookie_httponly', '1');
        ini_set('session.cache_limiter', '');
        ini_set('session.gc_maxlifetime', (string) max(1440, $lifetimeSeconds));
        ini_set('session.gc_probability', '1');
        ini_set('session.gc_divisor', '100');

        session_set_cookie_params([
            'lifetime' => 0,
            'path' => $path,
            'secure' => $request->https,
            'httponly' => true,
            'samesite' => 'Strict',
        ]);

        session_start();
    }

    /** The session's CSRF token, created on first use. */
    public static function csrfToken(): string
    {
        if (!isset($_SESSION['csrf']) || !is_string($_SESSION['csrf'])) {
            $_SESSION['csrf'] = bin2hex(random_bytes(32));
        }

        return $_SESSION['csrf'];
    }

    public static function csrfField(): string
    {
        return '<input type="hidden" name="csrf" value="' . Html::e(self::csrfToken()) . '">';
    }

    /**
     * Whether a POST carries this session's CSRF token, and — when the browser
     * says where the form came from — came from this site.
     */
    public static function checkCsrf(Request $request): bool
    {
        $expected = $_SESSION['csrf'] ?? null;
        $given = $request->field('csrf');

        if (!is_string($expected) || $given === '' || !hash_equals($expected, $given)) {
            return false;
        }

        $origin = $request->header('origin');
        if ($origin !== null && $origin !== 'null') {
            $originHost = parse_url($origin, PHP_URL_HOST);
            $host = preg_replace('/:\d+$/', '', $request->header('host') ?? '');
            if (!is_string($originHost) || strcasecmp($originHost, (string) $host) !== 0) {
                return false;
            }
        }

        return true;
    }

    /** New session id (after sign-in), and a new CSRF token with it. */
    public static function regenerate(): void
    {
        session_regenerate_id(true);
        $_SESSION['csrf'] = bin2hex(random_bytes(32));
    }

    /** Forget everything in the session and move it to a new id, keeping it usable for a sign-in form. */
    public static function reset(): void
    {
        $_SESSION = [];
        session_regenerate_id(true);
    }

    public static function destroy(): void
    {
        $_SESSION = [];
        if (session_status() === PHP_SESSION_ACTIVE) {
            $params = session_get_cookie_params();
            setcookie(session_name(), '', [
                'expires' => 1,
                'path' => $params['path'],
                'secure' => $params['secure'],
                'httponly' => true,
                'samesite' => 'Strict',
            ]);
            session_destroy();
        }
    }

    /** Store something to show once, on the next page. */
    public static function flash(string $key, mixed $value): void
    {
        $_SESSION['flash'][$key] = $value;
    }

    public static function takeFlash(string $key): mixed
    {
        $value = $_SESSION['flash'][$key] ?? null;
        unset($_SESSION['flash'][$key]);

        return $value;
    }
}
