<?php
define('DB_HOST', 'localhost');
define('DB_NAME', 'cm135994_dutchlegions');
define('DB_USER', 'cm135994_dutchlegions');
define('DB_PASS', '^Pvyrn2bRnQLXS12QW6U');
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
// Decodeert de JWT-payload en controleert vervaldatum + uitgever (EVE SSO).
function eveVerify(string $token): ?int {
    $parts = explode('.', $token);
    if (count($parts) < 2) return null;
    $b64 = strtr($parts[1], '-_', '+/');
    $b64 .= str_repeat('=', (4 - strlen($b64) % 4) % 4);
    $payload = json_decode(base64_decode($b64), true);
    if (!is_array($payload)) return null;
    if (isset($payload['exp']) && (int)$payload['exp'] < time()) return null;       // verlopen
    if (strpos((string)($payload['iss'] ?? ''), 'login.eveonline.com') === false) return null; // verkeerde uitgever
    $sub = (string)($payload['sub'] ?? '');
    if (strpos($sub, ':') !== false) $sub = substr(strrchr($sub, ':'), 1);          // CHARACTER:EVE:<id>
    return ctype_digit($sub) ? (int)$sub : null;
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

// Rol van een character: 'admin' | 'recruiter' | 'member' (uitbreidbaar). Owner = altijd admin.
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

// Is dit character een recruiting-admin? (owner OF rol admin/recruiter OF de oude recruit_admins-tabel)
function isRecruitAdmin(int $cid): bool {
    if ($cid === ADMIN_CHAR_ID) return true;
    $role = roleOf($cid);
    if ($role === 'admin' || $role === 'recruiter') return true;
    try {
        $pdo = getDB();
        $pdo->exec("CREATE TABLE IF NOT EXISTS recruit_admins (character_id BIGINT PRIMARY KEY, name VARCHAR(128), added_by BIGINT, created_at DATETIME)");
        $st = $pdo->prepare("SELECT 1 FROM recruit_admins WHERE character_id = ?");
        $st->execute([$cid]);
        return (bool)$st->fetchColumn();
    } catch (Exception $e) { return false; }
}
