<?php
define('DB_HOST', 'localhost');
define('DB_NAME', 'cm135994_dutchlegions');
define('DB_USER', 'cm135994_dutchlegions');
// Het wachtwoord staat niet in de repo (die is openbaar). Bij het deployen
// schrijft GitHub Actions het uit het geheim DB_PASS in config.geheim.php
// (tools/schrijf-geheim.mjs); dat bestand bestaat alleen op de server.
require __DIR__ . '/config.geheim.php';
define('ADMIN_CHAR_ID', 1831618559);
define('GITHUB_REPO', 'jweijdert-eng/dutchlegions-dashboard');

function getDB(): PDO {
    $pdo = new PDO('mysql:host='.DB_HOST.';dbname='.DB_NAME.';charset=utf8', DB_USER, DB_PASS);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    return $pdo;
}

function cors(): void {
    header('Content-Type: application/json');
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type');
    if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') exit;
}

// Verifieer een EVE v2 access-token → character-id (of null als ongeldig/verlopen).
// Het token is een JWT die EVE SSO ondertekent (RS256). Alleen de inhoud uitlezen
// is niet genoeg: een zelfgemaakt token met iemands character-id ziet er dan precies
// hetzelfde uit. Daarom eerst de handtekening tegen de publieke sleutel van EVE.
function eveVerify(string $token): ?int {
    $parts = explode('.', $token);
    if (count($parts) !== 3) return null;
    $kop     = json_decode(b64url($parts[0]), true);
    $payload = json_decode(b64url($parts[1]), true);
    if (!is_array($kop) || !is_array($payload)) return null;
    if (($kop['alg'] ?? '') !== 'RS256') return null;
    $pem = eveSigningKey((string)($kop['kid'] ?? ''));
    if ($pem === null) return null;
    if (openssl_verify($parts[0] . '.' . $parts[1], b64url($parts[2]), $pem, OPENSSL_ALGO_SHA256) !== 1) return null;
    if ((int)($payload['exp'] ?? 0) < time()) return null;                          // verlopen
    if (!in_array((string)($payload['iss'] ?? ''), ['https://login.eveonline.com', 'login.eveonline.com'], true)) return null;
    if (!in_array('EVE Online', (array)($payload['aud'] ?? []), true)) return null;
    $sub = (string)($payload['sub'] ?? '');
    if (strpos($sub, ':') !== false) $sub = substr(strrchr($sub, ':'), 1);          // CHARACTER:EVE:<id>
    return ctype_digit($sub) ? (int)$sub : null;
}

function b64url(string $s): string {
    return (string)base64_decode(strtr($s, '-_', '+/') . str_repeat('=', (4 - strlen($s) % 4) % 4));
}

// De publieke sleutel van EVE SSO (PEM) voor een kid. De sleutelset wordt een dag
// bewaard; staat de kid er niet in (EVE heeft een nieuwe sleutel), dan halen we hem
// opnieuw op, hooguit eens per vijf minuten.
function eveSigningKey(string $kid): ?string {
    $bestand = __DIR__ . '/.eve-jwks.json';
    $set = json_decode((string)@file_get_contents($bestand), true);
    $leeftijd = is_file($bestand) ? time() - filemtime($bestand) : PHP_INT_MAX;
    $zoek = function ($set) use ($kid) {
        foreach (($set['keys'] ?? []) as $k) {
            if (($k['kty'] ?? '') === 'RSA' && ($k['kid'] ?? '') === $kid && isset($k['n'], $k['e'])) return rsaPem(b64url($k['n']), b64url($k['e']));
        }
        return null;
    };
    $pem = is_array($set) && $leeftijd < 86400 ? $zoek($set) : null;
    if ($pem !== null || $leeftijd < 300) return $pem;

    $ch = curl_init('https://login.eveonline.com/oauth/jwks');
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 6, CURLOPT_USERAGENT => 'dutchlegionsdashboard.eu']);
    $ruw = curl_exec($ch);
    $ok  = curl_getinfo($ch, CURLINFO_HTTP_CODE) === 200;
    curl_close($ch);
    $nieuw = $ok ? json_decode((string)$ruw, true) : null;
    if (!is_array($nieuw) || empty($nieuw['keys'])) return is_array($set) ? $zoek($set) : null;
    @file_put_contents($bestand, json_encode($nieuw), LOCK_EX);
    return $zoek($nieuw);
}

// RSA-modulus en -exponent (ruwe bytes) → PEM-publieke sleutel (SubjectPublicKeyInfo).
function rsaPem(string $n, string $e): string {
    $len = function (int $l): string {
        if ($l < 0x80) return chr($l);
        $s = ltrim(pack('N', $l), "\0");
        return chr(0x80 | strlen($s)) . $s;
    };
    $int = function (string $b) use ($len): string { if (ord($b[0]) > 0x7f) $b = "\0" . $b; return "\x02" . $len(strlen($b)) . $b; };
    $seq = function (string $b) use ($len): string { return "\x30" . $len(strlen($b)) . $b; };
    $rsa = $seq($int($n) . $int($e));
    $alg = $seq("\x06\x09\x2a\x86\x48\x86\xf7\x0d\x01\x01\x01\x05\x00");   // rsaEncryption, NULL
    $der = $seq($alg . "\x03" . $len(strlen($rsa) + 1) . "\x00" . $rsa);
    return "-----BEGIN PUBLIC KEY-----\n" . chunk_split(base64_encode($der), 64, "\n") . "-----END PUBLIC KEY-----\n";
}

// Haal het geverifieerde character-id uit een meegestuurd EVE-token (body 'token' of query 'token').
// Retourneert null als er geen geldig, niet-verlopen EVE-token is meegestuurd.
function authCharId(array $body = []): ?int {
    return eveVerify((string)($body['token'] ?? $_GET['token'] ?? ''));
}

// Dwing admin-rechten af op basis van een geverifieerd token; stuurt 403 en stopt bij afwezigheid.
// Vervangt de oude, spoofbare `adminCharId`-check (character-ID's zijn publieke EVE-data).
function requireAdmin(array $body = []): int {
    $cid = authCharId($body);
    if (!$cid || !isAdminRole($cid)) {
        http_response_code(403);
        echo json_encode(['error' => 'forbidden']);
        exit;
    }
    return $cid;
}

// Zorg dat de members-tabel een `allowed`-kolom heeft (allowlist voor de toegangs-gate).
function ensureMembersSchema(PDO $pdo): void {
    try { $pdo->query('SELECT allowed FROM members LIMIT 1'); }
    catch (Exception $e) { try { $pdo->exec('ALTER TABLE members ADD COLUMN allowed TINYINT NOT NULL DEFAULT 0'); } catch (Exception $e2) {} }
}

// Rollen-tabel klaarzetten (idempotent).
function ensureRolesSchema(PDO $pdo): void {
    $pdo->exec("CREATE TABLE IF NOT EXISTS roles (
        character_id BIGINT PRIMARY KEY,
        role VARCHAR(20) NOT NULL DEFAULT 'member',
        name VARCHAR(128),
        added_by BIGINT,
        updated_at DATETIME
    )");
}

// Rol van een character: 'admin' | 'member' (uitbreidbaar). Owner = altijd admin.
function roleOf(int $cid): string {
    if ($cid === ADMIN_CHAR_ID) return 'admin';
    try {
        $pdo = getDB();
        ensureRolesSchema($pdo);
        $st = $pdo->prepare("SELECT role FROM roles WHERE character_id = ?");
        $st->execute([$cid]);
        $r = $st->fetchColumn();
        return $r ?: 'member';
    } catch (Exception $e) { return 'member'; }
}

// Heeft dit character admin-rechten? (owner OF rol 'admin')
function isAdminRole(int $cid): bool {
    return $cid === ADMIN_CHAR_ID || roleOf($cid) === 'admin';
}

