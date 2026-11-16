<?php
// Waar is iedereen: leden melden vanuit hun browser waar hun characters zitten
// (ESI-locatie met hun eigen token), de pagina /waar leest het terug.
//
// POST  { token, name, solar_system_id, station_id?, structure_id?, ship_type_id?, ship_name? }
//       Het token hoort bij het character waarover gemeld wordt, dus niemand kan
//       een ander character ergens neerzetten. { token, shared: false } haalt het
//       character uit de lijst (delen uitgezet in Instellingen).
// GET   alle gedeelde posities van de laatste 24 uur + de laatste bewegingen.
require_once 'config.php';
cors();

function ensureLocationsSchema(PDO $pdo): void {
    $pdo->exec("CREATE TABLE IF NOT EXISTS member_locations (
        character_id    BIGINT PRIMARY KEY,
        name            VARCHAR(128) NOT NULL,
        solar_system_id INT NOT NULL,
        station_id      BIGINT NULL,
        structure_id    BIGINT NULL,
        ship_type_id    INT NULL,
        ship_name       VARCHAR(128) NULL,
        changed_at      DATETIME NOT NULL,
        updated_at      DATETIME NOT NULL,
        INDEX (updated_at)
    )");
    $pdo->exec("CREATE TABLE IF NOT EXISTS member_location_log (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        character_id  BIGINT NOT NULL,
        name          VARCHAR(128) NOT NULL,
        from_system   INT NULL,
        to_system     INT NOT NULL,
        ship_type_id  INT NULL,
        at            DATETIME NOT NULL,
        INDEX (at)
    )");
}

function intOrNull($v): ?int {
    if ($v === null || $v === '' || !is_numeric($v)) return null;
    $n = (int)$v;
    return $n > 0 ? $n : null;
}

try {
    $pdo = getDB();
    ensureLocationsSchema($pdo);

    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        $data = json_decode(file_get_contents('php://input'), true);
        $data = is_array($data) ? $data : [];
        $cid  = requireMember($data);

        if (array_key_exists('shared', $data) && !$data['shared']) {
            $pdo->prepare('DELETE FROM member_locations WHERE character_id = ?')->execute([$cid]);
            echo json_encode(['ok' => true, 'shared' => false]);
            exit;
        }

        $sys = intOrNull($data['solar_system_id'] ?? null);
        if (!$sys) { http_response_code(400); echo json_encode(['error' => 'solar_system_id ontbreekt']); exit; }
        $name    = mb_substr(trim((string)($data['name'] ?? '')), 0, 128);
        $station = intOrNull($data['station_id'] ?? null);
        $struct  = intOrNull($data['structure_id'] ?? null);
        $shipT   = intOrNull($data['ship_type_id'] ?? null);
        $shipN   = mb_substr(trim((string)($data['ship_name'] ?? '')), 0, 128);
        if ($shipN === '') $shipN = null;

        $st = $pdo->prepare('SELECT name, solar_system_id, ship_type_id FROM member_locations WHERE character_id = ?');
        $st->execute([$cid]);
        $oud = $st->fetch(PDO::FETCH_ASSOC) ?: null;
        if ($name === '') $name = $oud['name'] ?? ('#' . $cid);

        $sprong = $oud && (int)$oud['solar_system_id'] !== $sys;
        $veranderd = !$oud || $sprong || (int)($oud['ship_type_id'] ?? 0) !== (int)($shipT ?? 0);

        if ($oud) {
            $sql = 'UPDATE member_locations SET name = ?, solar_system_id = ?, station_id = ?, structure_id = ?, ship_type_id = ?, ship_name = ?, updated_at = NOW()'
                 . ($veranderd ? ', changed_at = NOW()' : '') . ' WHERE character_id = ?';
            $pdo->prepare($sql)->execute([$name, $sys, $station, $struct, $shipT, $shipN, $cid]);
        } else {
            $pdo->prepare('INSERT INTO member_locations (character_id, name, solar_system_id, station_id, structure_id, ship_type_id, ship_name, changed_at, updated_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())')
                ->execute([$cid, $name, $sys, $station, $struct, $shipT, $shipN]);
        }

        // Eerste melding of een sprong naar een ander systeem = regel in de feed.
        if (!$oud || $sprong) {
            $pdo->prepare('INSERT INTO member_location_log (character_id, name, from_system, to_system, ship_type_id, at) VALUES (?, ?, ?, ?, ?, NOW())')
                ->execute([$cid, $name, $oud ? (int)$oud['solar_system_id'] : null, $sys, $shipT]);
        }
        // Af en toe opruimen: feed ouder dan 7 dagen, posities ouder dan 30 dagen.
        if (mt_rand(1, 50) === 1) {
            $pdo->exec('DELETE FROM member_location_log WHERE at < NOW() - INTERVAL 7 DAY');
            $pdo->exec('DELETE FROM member_locations WHERE updated_at < NOW() - INTERVAL 30 DAY');
        }
        echo json_encode(['ok' => true, 'changed' => $veranderd, 'jump' => (bool)$sprong]);
        exit;
    }

    if ($_SERVER['REQUEST_METHOD'] !== 'GET') { http_response_code(405); exit; }
    requireMember();

    $rows = $pdo->query('SELECT character_id, name, solar_system_id, station_id, structure_id, ship_type_id, ship_name,
                                changed_at, updated_at,
                                TIMESTAMPDIFF(SECOND, updated_at, NOW()) AS age,
                                TIMESTAMPDIFF(SECOND, changed_at, NOW()) AS since_change
                         FROM member_locations
                         WHERE updated_at >= NOW() - INTERVAL 1 DAY
                         ORDER BY updated_at DESC')->fetchAll(PDO::FETCH_ASSOC);
    foreach ($rows as &$r) {
        $r['character_id']    = (int)$r['character_id'];
        $r['solar_system_id'] = (int)$r['solar_system_id'];
        $r['station_id']      = $r['station_id'] !== null ? (int)$r['station_id'] : null;
        $r['structure_id']    = $r['structure_id'] !== null ? (int)$r['structure_id'] : null;
        $r['ship_type_id']    = $r['ship_type_id'] !== null ? (int)$r['ship_type_id'] : null;
        $r['age']             = max(0, (int)$r['age']);
        $r['since_change']    = max(0, (int)$r['since_change']);
    }
    unset($r);

    $feed = $pdo->query('SELECT character_id, name, from_system, to_system, ship_type_id, at,
                                TIMESTAMPDIFF(SECOND, at, NOW()) AS age
                         FROM member_location_log
                         WHERE at >= NOW() - INTERVAL 1 DAY
                         ORDER BY at DESC, id DESC LIMIT 80')->fetchAll(PDO::FETCH_ASSOC);
    foreach ($feed as &$f) {
        $f['character_id'] = (int)$f['character_id'];
        $f['from_system']  = $f['from_system'] !== null ? (int)$f['from_system'] : null;
        $f['to_system']    = (int)$f['to_system'];
        $f['ship_type_id'] = $f['ship_type_id'] !== null ? (int)$f['ship_type_id'] : null;
        $f['age']          = max(0, (int)$f['age']);
    }
    unset($f);

    echo json_encode(['ok' => true, 'now' => gmdate('c'), 'members' => $rows, 'feed' => $feed]);
} catch (Exception $e) {
    http_response_code(500);
    serverFout($e);
}
