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

// Verifieer een EVE access-token bij EVE SSO → character-id (of null als ongeldig).
// Veilig: EVE valideert de token; we vertrouwen geen client-opgegeven id.
function eveVerify(string $token): ?int {
    if ($token === '') return null;
    $ctx = stream_context_create(['http' => [
        'method' => 'GET',
        'header' => "Authorization: Bearer $token\r\n",
        'ignore_errors' => true,
        'timeout' => 8,
    ]]);
    $r = @file_get_contents('https://login.eveonline.com/oauth/verify', false, $ctx);
    if ($r === false) return null;
    $j = json_decode($r, true);
    return isset($j['CharacterID']) ? (int)$j['CharacterID'] : null;
}
