<?php
require_once 'config.php';
cors();

// Beheer van recruiting-admins. Lezen mag elke admin; toevoegen/verwijderen
// alleen de vaste eigenaar (ADMIN_CHAR_ID). Dient ook als rol-check: een
// niet-admin krijgt 403 (zo weet de frontend of dit character admin is).
$cid = eveVerify($_GET['token'] ?? '');
if (!$cid || !isRecruitAdmin($cid)) { http_response_code(403); echo json_encode(['error' => 'forbidden']); exit; }
$isSuper = ($cid === ADMIN_CHAR_ID);

try {
    $pdo = getDB();
    $pdo->exec("CREATE TABLE IF NOT EXISTS recruit_admins (character_id BIGINT PRIMARY KEY, name VARCHAR(128), added_by BIGINT, created_at DATETIME)");

    if (isset($_GET['add'])) {
        if (!$isSuper) { http_response_code(403); echo json_encode(['error' => 'only owner']); exit; }
        $aid = (int)$_GET['add'];
        $name = mb_substr((string)($_GET['name'] ?? ''), 0, 128);
        if ($aid > 0 && $aid !== ADMIN_CHAR_ID) {
            $pdo->prepare("INSERT INTO recruit_admins (character_id, name, added_by, created_at) VALUES (?, ?, ?, NOW())
                ON DUPLICATE KEY UPDATE name = VALUES(name)")->execute([$aid, $name, $cid]);
        }
        echo json_encode(['ok' => true]); exit;
    }
    if (isset($_GET['remove'])) {
        if (!$isSuper) { http_response_code(403); echo json_encode(['error' => 'only owner']); exit; }
        $pdo->prepare("DELETE FROM recruit_admins WHERE character_id = ?")->execute([(int)$_GET['remove']]);
        echo json_encode(['ok' => true]); exit;
    }

    $rows = $pdo->query("SELECT character_id, name, added_by, created_at FROM recruit_admins ORDER BY created_at")->fetchAll(PDO::FETCH_ASSOC);
    echo json_encode(['admin' => true, 'super' => $isSuper, 'owner_id' => ADMIN_CHAR_ID, 'admins' => $rows]);
} catch (Exception $e) {
    http_response_code(500);
    echo json_encode(['error' => $e->getMessage()]);
}
