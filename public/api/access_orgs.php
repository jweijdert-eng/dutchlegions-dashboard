<?php
require_once 'config.php';
cors();

// Allowlist van hele corps/alliances voor de dashboard-toegang.
// GET = publiek (de login-gate leest dit). POST = alleen admin.
$pdo = getDB();
$pdo->exec("CREATE TABLE IF NOT EXISTS allowed_orgs (
    org_id BIGINT PRIMARY KEY, type VARCHAR(10), name VARCHAR(128), created_at DATETIME
)");

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $rows = $pdo->query("SELECT org_id, type, name FROM allowed_orgs ORDER BY type, name")->fetchAll(PDO::FETCH_ASSOC);
    foreach ($rows as &$r) $r['org_id'] = (int)$r['org_id'];
    echo json_encode($rows); exit;
}

$body = json_decode(file_get_contents('php://input'), true) ?? [];
if ((int)($body['adminCharId'] ?? 0) !== ADMIN_CHAR_ID) { http_response_code(403); echo json_encode(['error' => 'forbidden']); exit; }
$action = $body['action'] ?? '';

if ($action === 'add') {
    $oid  = (int)($body['orgId'] ?? 0);
    $type = (($body['orgType'] ?? '') === 'alliance') ? 'alliance' : 'corp';
    $name = mb_substr((string)($body['name'] ?? ''), 0, 128);
    if ($oid > 0) {
        $pdo->prepare("INSERT INTO allowed_orgs (org_id, type, name, created_at) VALUES (?, ?, ?, NOW())
            ON DUPLICATE KEY UPDATE name = VALUES(name), type = VALUES(type)")->execute([$oid, $type, $name]);
    }
    echo json_encode(['ok' => true]); exit;
}
if ($action === 'remove') {
    $pdo->prepare("DELETE FROM allowed_orgs WHERE org_id = ?")->execute([(int)($body['orgId'] ?? 0)]);
    echo json_encode(['ok' => true]); exit;
}

http_response_code(400); echo json_encode(['error' => 'bad action']);
