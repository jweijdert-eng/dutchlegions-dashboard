<?php
// Ideeënbus — leden sturen ideeën in (token-geverifieerd). Alleen admins zien de hele
// lijst; een lid ziet enkel zijn eigen idee(ën) + de reacties erop. Admin kan een status
// zetten (open/gepland/klaar) en reageren. Patroon volgt guestchat.php/ansiblex.php.
require_once 'config.php';
cors();
$pdo = getDB();

$pdo->exec("CREATE TABLE IF NOT EXISTS ideas (
    id INT AUTO_INCREMENT PRIMARY KEY,
    character_id BIGINT,
    character_name VARCHAR(128),
    title VARCHAR(140),
    body TEXT,
    status VARCHAR(16) NOT NULL DEFAULT 'open',
    created_at DATETIME,
    updated_at DATETIME
)");
$pdo->exec("CREATE TABLE IF NOT EXISTS idea_replies (
    id INT AUTO_INCREMENT PRIMARY KEY,
    idea_id INT,
    character_id BIGINT,
    character_name VARCHAR(128),
    is_admin TINYINT NOT NULL DEFAULT 0,
    body TEXT,
    created_at DATETIME
)");

$STATUSES = ['open', 'gepland', 'klaar'];

// Idee-rij + reacties als JSON-vriendelijke structuur.
function repliesFor(PDO $pdo, int $ideaId): array {
    $st = $pdo->prepare('SELECT id, character_id, character_name, is_admin, body, created_at FROM idea_replies WHERE idea_id = ? ORDER BY id ASC');
    $st->execute([$ideaId]);
    return array_map(function ($r) {
        return [
            'id'        => (int)$r['id'],
            'author'    => $r['character_name'],
            'isAdmin'   => (bool)(int)$r['is_admin'],
            'body'      => $r['body'],
            'createdAt' => $r['created_at'],
        ];
    }, $st->fetchAll(PDO::FETCH_ASSOC));
}

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $cid = eveVerify($_GET['token'] ?? '');
    if (!$cid) { http_response_code(403); echo json_encode(['error' => 'Niet ingelogd']); exit; }
    $admin = isAdminRole($cid);

    // Lichtgewicht teller voor de sidebar-badge (admin: aantal open ideeën).
    if (($_GET['action'] ?? '') === 'count') {
        $open = $admin ? (int)$pdo->query("SELECT COUNT(*) FROM ideas WHERE status = 'open'")->fetchColumn() : 0;
        echo json_encode(['isAdmin' => $admin, 'open' => $open]);
        exit;
    }

    if ($admin) {
        $rows = $pdo->query('SELECT * FROM ideas ORDER BY id DESC')->fetchAll(PDO::FETCH_ASSOC);
    } else {
        $st = $pdo->prepare('SELECT * FROM ideas WHERE character_id = ? ORDER BY id DESC');
        $st->execute([$cid]);
        $rows = $st->fetchAll(PDO::FETCH_ASSOC);
    }
    $ideas = array_map(function ($r) use ($pdo) {
        return [
            'id'        => (int)$r['id'],
            'author'    => $r['character_name'],
            'title'     => $r['title'],
            'body'      => $r['body'],
            'status'    => $r['status'],
            'createdAt' => $r['created_at'],
            'replies'   => repliesFor($pdo, (int)$r['id']),
        ];
    }, $rows);
    echo json_encode(['isAdmin' => $admin, 'ideas' => $ideas]);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $data = json_decode(file_get_contents('php://input'), true) ?? [];
    $cid = eveVerify($data['token'] ?? '');
    if (!$cid) { http_response_code(403); echo json_encode(['error' => 'Niet ingelogd']); exit; }
    $admin  = isAdminRole($cid);
    $action = (string)($data['action'] ?? 'create');
    $name   = mb_substr(trim((string)($data['characterName'] ?? '')), 0, 128) ?: ('Char ' . $cid);

    if ($action === 'status') {
        if (!$admin) { http_response_code(403); echo json_encode(['error' => 'Alleen admin']); exit; }
        $status = (string)($data['status'] ?? '');
        if (!in_array($status, $STATUSES, true)) { http_response_code(400); echo json_encode(['error' => 'Ongeldige status']); exit; }
        $st = $pdo->prepare('UPDATE ideas SET status = ?, updated_at = NOW() WHERE id = ?');
        $st->execute([$status, (int)($data['ideaId'] ?? 0)]);
        echo json_encode(['ok' => true]);
        exit;
    }

    if ($action === 'reply') {
        $ideaId = (int)($data['ideaId'] ?? 0);
        $body   = mb_substr(trim((string)($data['body'] ?? '')), 0, 2000);
        if ($ideaId <= 0 || $body === '') { http_response_code(400); echo json_encode(['error' => 'Lege reactie']); exit; }
        // Een lid mag enkel reageren op zijn eigen idee; admin op alles.
        $own = $pdo->prepare('SELECT character_id FROM ideas WHERE id = ?');
        $own->execute([$ideaId]);
        $ownerId = $own->fetchColumn();
        if ($ownerId === false) { http_response_code(404); echo json_encode(['error' => 'Idee niet gevonden']); exit; }
        if (!$admin && (int)$ownerId !== $cid) { http_response_code(403); echo json_encode(['error' => 'Geen toegang']); exit; }
        $st = $pdo->prepare('INSERT INTO idea_replies (idea_id, character_id, character_name, is_admin, body, created_at) VALUES (?, ?, ?, ?, ?, NOW())');
        $st->execute([$ideaId, $cid, $name, $admin ? 1 : 0, $body]);
        $pdo->prepare('UPDATE ideas SET updated_at = NOW() WHERE id = ?')->execute([$ideaId]);
        echo json_encode(['ok' => true, 'id' => (int)$pdo->lastInsertId()]);
        exit;
    }

    // Nieuw idee insturen.
    $title = mb_substr(trim((string)($data['title'] ?? '')), 0, 140);
    $body  = mb_substr(trim((string)($data['body'] ?? '')), 0, 2000);
    if ($body === '') { http_response_code(400); echo json_encode(['error' => 'Leeg idee']); exit; }
    if ($title === '') $title = mb_substr(explode("\n", $body)[0], 0, 140);
    // Simpele rate-limit: max 5 ideeën per 5 min per character.
    $rl = $pdo->prepare('SELECT COUNT(*) FROM ideas WHERE character_id = ? AND created_at > (NOW() - INTERVAL 5 MINUTE)');
    $rl->execute([$cid]);
    if ((int)$rl->fetchColumn() >= 5) { http_response_code(429); echo json_encode(['error' => 'Te snel — probeer zo nog eens']); exit; }
    $st = $pdo->prepare('INSERT INTO ideas (character_id, character_name, title, body, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NOW(), NOW())');
    $st->execute([$cid, $name, $title, $body, 'open']);
    echo json_encode(['ok' => true, 'id' => (int)$pdo->lastInsertId()]);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] === 'DELETE') {
    $data = json_decode(file_get_contents('php://input'), true) ?? [];
    $cid = eveVerify($data['token'] ?? '');
    if (!$cid) { http_response_code(403); echo json_encode(['error' => 'Niet ingelogd']); exit; }
    $admin = isAdminRole($cid);
    $ideaId = (int)($data['ideaId'] ?? 0);
    if ($ideaId <= 0) { http_response_code(400); echo json_encode(['error' => 'Geen idee-id']); exit; }
    $own = $pdo->prepare('SELECT character_id FROM ideas WHERE id = ?');
    $own->execute([$ideaId]);
    $ownerId = $own->fetchColumn();
    if ($ownerId === false) { echo json_encode(['ok' => true]); exit; }
    if (!$admin && (int)$ownerId !== $cid) { http_response_code(403); echo json_encode(['error' => 'Geen toegang']); exit; }
    $pdo->prepare('DELETE FROM idea_replies WHERE idea_id = ?')->execute([$ideaId]);
    $pdo->prepare('DELETE FROM ideas WHERE id = ?')->execute([$ideaId]);
    echo json_encode(['ok' => true]);
    exit;
}

http_response_code(405);
echo json_encode(['error' => 'method not allowed']);
