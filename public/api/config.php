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

// Is dit character een recruiting-admin? (vaste eigenaar OF in de recruit_admins-tabel)
function isRecruitAdmin(int $cid): bool {
    if ($cid === ADMIN_CHAR_ID) return true;
    try {
        $pdo = getDB();
        $pdo->exec("CREATE TABLE IF NOT EXISTS recruit_admins (character_id BIGINT PRIMARY KEY, name VARCHAR(128), added_by BIGINT, created_at DATETIME)");
        $st = $pdo->prepare("SELECT 1 FROM recruit_admins WHERE character_id = ?");
        $st->execute([$cid]);
        return (bool)$st->fetchColumn();
    } catch (Exception $e) { return false; }
}
