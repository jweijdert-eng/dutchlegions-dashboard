<?php
// Rollen-beheer: GET → { me: <eigen rol>, roles: [...] (alleen als je admin bent) }.
// POST (admin) → { characterId, name, role } zet een rol. role='member' verwijdert de rij.
require_once 'config.php';
cors();

$cid = eveVerify($_GET['token'] ?? '');

try {
    $pdo = getDB();
    ensureRolesSchema($pdo);

    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        if (!$cid || !isAdminRole($cid)) { http_response_code(403); echo json_encode(['error' => 'forbidden']); exit; }
        $body   = json_decode(file_get_contents('php://input'), true) ?? [];
        $target = (int)($body['characterId'] ?? 0);
        $name   = mb_substr(trim((string)($body['name'] ?? '')), 0, 128);
        $role   = preg_match('/^[a-z]{2,20}$/', (string)($body['role'] ?? '')) ? $body['role'] : 'member';
        if (!$target) { http_response_code(400); echo json_encode(['error' => 'no id']); exit; }
        if ($target === ADMIN_CHAR_ID) { http_response_code(400); echo json_encode(['error' => 'owner']); exit; }  // owner is onaantastbaar

        if ($role === 'member') {
            $pdo->prepare("DELETE FROM roles WHERE character_id = ?")->execute([$target]);
        } else {
            $pdo->prepare("INSERT INTO roles (character_id, role, name, added_by, updated_at) VALUES (?,?,?,?,NOW())
                           ON DUPLICATE KEY UPDATE role=VALUES(role), name=VALUES(name), added_by=VALUES(added_by), updated_at=NOW()")
                ->execute([$target, $role, $name, $cid]);
        }
        echo json_encode(['ok' => true]);
        exit;
    }

    // GET
    $me   = $cid ? roleOf($cid) : 'guest';
    $list = [];
    if ($cid && isAdminRole($cid)) {
        $list = $pdo->query("SELECT character_id, name, role FROM roles ORDER BY FIELD(role,'admin','recruiter') , name")->fetchAll(PDO::FETCH_ASSOC);
    }
    echo json_encode(['me' => $me, 'roles' => $list]);
} catch (Exception $e) {
    http_response_code(500);
    echo json_encode(['error' => $e->getMessage()]);
}
