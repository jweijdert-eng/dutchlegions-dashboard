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
// Client-id van onze EVE-app (openbaar, staat ook in de bundle). Alleen tokens die
// EVE voor deze app heeft uitgegeven tellen; een token van een andere EVE-tool niet.
define('EVE_CLIENT_ID', '28c22b1bbaeb4058bac25924e60d9266');
define('CORP_ID', 98652891);
define('ALLIANCE_ID', 99013537);

function getDB(): PDO {
    $pdo = new PDO('mysql:host='.DB_HOST.';dbname='.DB_NAME.';charset=utf8', DB_USER, DB_PASS);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    return $pdo;
}

function cors(): void {
    header('Content-Type: application/json');
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type, X-Token');
    if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') exit;
}

// Interne fout: details alleen in de serverlog, de buitenwereld krijgt een kale melding.
function serverFout(Throwable $e): void {
    error_log('[dashboard] ' . basename($_SERVER['SCRIPT_NAME'] ?? '') . ': ' . $e->getMessage());
    http_response_code(500);
    echo json_encode(['error' => 'Serverfout']);
}

// Het EVE-token van het verzoek: bij voorkeur uit de X-Token-header (dan staat het niet
// in de URL en dus niet in de serverlogs), anders uit de body of de query.
function verzoekToken(array $body = []): string {
    $h = trim((string)($_SERVER['HTTP_X_TOKEN'] ?? ''));
    if ($h !== '') return $h;
    return (string)($body['token'] ?? $_GET['token'] ?? '');
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
    if ((string)($payload['azp'] ?? '') !== EVE_CLIENT_ID) return null;               // voor ónze app uitgegeven
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
    return eveVerify(verzoekToken($body));
}

// Mag dit character het dashboard gebruiken? Dezelfde regels als de toegangspoort in de
// browser (Callback.tsx): admin altijd; geblokkeerd nooit; daarna corp/alliance-eis,
// de allowlist per character en de allowlist van hele corps/alliances.
function isMember(?int $cid): bool {
    static $cache = [];
    if (!$cid) return false;
    if (isset($cache[$cid])) return $cache[$cid];
    if (isAdminRole($cid)) return $cache[$cid] = true;
    try {
        $pdo = getDB();
        ensureMembersSchema($pdo);
        $st = $pdo->prepare('SELECT * FROM members WHERE character_id = ?');
        $st->execute([$cid]);
        $m = $st->fetch(PDO::FETCH_ASSOC) ?: [];
        if ((int)($m['blocked'] ?? 0) === 1) return $cache[$cid] = false;

        $set = [];
        foreach ($pdo->query("SELECT `key`, value FROM settings WHERE `key` IN ('require_corp','require_alliance')") as $r) {
            $set[$r['key']] = $r['value'] === 'true';
        }
        $eisCorp = $set['require_corp'] ?? false;
        $eisAll  = $set['require_alliance'] ?? false;
        if (!$eisCorp && !$eisAll) return $cache[$cid] = true;
        if ((int)($m['allowed'] ?? 0) === 1) return $cache[$cid] = true;

        $aff = affiliatie($pdo, $cid);
        if ($aff === null) return $cache[$cid] = false;
        [$corp, $all] = $aff;
        if (($eisCorp && $corp === CORP_ID) || ($eisAll && $all === ALLIANCE_ID)) return $cache[$cid] = true;

        $pdo->exec("CREATE TABLE IF NOT EXISTS allowed_orgs (org_id BIGINT PRIMARY KEY, type VARCHAR(16), name VARCHAR(128), created_at DATETIME)");
        $st = $pdo->prepare("SELECT 1 FROM allowed_orgs WHERE (type = 'corp' AND org_id = ?) OR (type = 'alliance' AND org_id = ?)");
        $st->execute([$corp, $all ?: -1]);
        return $cache[$cid] = (bool)$st->fetchColumn();
    } catch (Throwable $e) {
        error_log('[dashboard] isMember: ' . $e->getMessage());
        return $cache[$cid] = false;
    }
}

// [corp-id, alliance-id of 0] van een character, via ESI; een uur bewaard in de DB. Is ESI
// onbereikbaar, dan geldt de laatst bekende stand; zonder stand null.
function affiliatie(PDO $pdo, int $cid): ?array {
    $pdo->exec("CREATE TABLE IF NOT EXISTS member_aff (
        character_id BIGINT PRIMARY KEY, corp_id BIGINT NOT NULL, alliance_id BIGINT NOT NULL DEFAULT 0, checked_at DATETIME NOT NULL)");
    $st = $pdo->prepare('SELECT corp_id, alliance_id, checked_at FROM member_aff WHERE character_id = ?');
    $st->execute([$cid]);
    $oud = $st->fetch(PDO::FETCH_ASSOC);
    if ($oud && strtotime($oud['checked_at'] . ' UTC') > time() - 3600) return [(int)$oud['corp_id'], (int)$oud['alliance_id']];

    $ch = curl_init('https://esi.evetech.net/latest/characters/affiliation/?datasource=tranquility');
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_POST => true, CURLOPT_POSTFIELDS => json_encode([$cid]),
        CURLOPT_HTTPHEADER => ['Content-Type: application/json'], CURLOPT_TIMEOUT => 6, CURLOPT_USERAGENT => 'dutchlegionsdashboard.eu']);
    $ruw = curl_exec($ch);
    $ok  = curl_getinfo($ch, CURLINFO_HTTP_CODE) === 200;
    curl_close($ch);
    $d = $ok ? json_decode((string)$ruw, true) : null;
    if (is_array($d) && isset($d[0]['corporation_id'])) {
        $corp = (int)$d[0]['corporation_id'];
        $all  = (int)($d[0]['alliance_id'] ?? 0);
        $pdo->prepare('INSERT INTO member_aff (character_id, corp_id, alliance_id, checked_at) VALUES (?,?,?,UTC_TIMESTAMP())
                       ON DUPLICATE KEY UPDATE corp_id = VALUES(corp_id), alliance_id = VALUES(alliance_id), checked_at = UTC_TIMESTAMP()')
            ->execute([$cid, $corp, $all]);
        return [$corp, $all];
    }
    return $oud ? [(int)$oud['corp_id'], (int)$oud['alliance_id']] : null;
}

// Geverifieerd token van een lid vereist; stuurt 403 en stopt anders. Geeft het character-id.
function requireMember(array $body = []): int {
    $cid = authCharId($body);
    if (!$cid || !isMember($cid)) {
        http_response_code(403);
        echo json_encode(['error' => 'forbidden']);
        exit;
    }
    return $cid;
}

// Character-id als het een lid is, anders null (voor endpoints die zelf hun 403 sturen).
function memberCharId(array $body = []): ?int {
    $cid = authCharId($body);
    return ($cid && isMember($cid)) ? $cid : null;
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

