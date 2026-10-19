#import <Foundation/Foundation.h>
#import <sqlite3.h>

// This is an identity cache, not a current-playback pointer. Never consult
// NEWFOLDERS, NEWFOLDERSONGS, account databases or cache access timestamps.
static NSDictionary *lookup(NSString *path, NSString *title) {
    sqlite3 *db = NULL;
    sqlite3_stmt *stmt = NULL;
    NSMutableArray *songs = [NSMutableArray array];
    NSString *failure = @"local-database-unavailable";
    if (sqlite3_open_v2(path.fileSystemRepresentation, &db, SQLITE_OPEN_READONLY | SQLITE_OPEN_NOMUTEX, NULL) != SQLITE_OK) goto done;
    sqlite3_busy_timeout(db, 100);
    sqlite3_limit(db, SQLITE_LIMIT_LENGTH, 16384);
    if (sqlite3_exec(db, "PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;", NULL, NULL, NULL) != SQLITE_OK) goto done;
    // Preparing the explicit projection also checks the supported private
    // schema. Missing or renamed columns fail closed, without a migration.
    const char *sql = "SELECT id,type,name,singer,album,K_SONG_RESERVE1,K_SONG_RESERVE9,K_SONG_RESERVE12 FROM SONGS WHERE name=?1 LIMIT 65";
    if (sqlite3_prepare_v2(db, sql, -1, &stmt, NULL) != SQLITE_OK) goto done;
    if (sqlite3_bind_text(stmt, 1, title.UTF8String, -1, SQLITE_TRANSIENT) != SQLITE_OK) goto done;
    int result;
    while ((result = sqlite3_step(stmt)) == SQLITE_ROW) {
        if (songs.count == 64) { failure = @"too-many-local-candidates"; goto done; }
        if (sqlite3_column_type(stmt, 0) != SQLITE_INTEGER || sqlite3_column_type(stmt, 1) != SQLITE_INTEGER
            || sqlite3_column_type(stmt, 7) != SQLITE_INTEGER) goto done;
        NSMutableArray *texts = [NSMutableArray array];
        for (int col = 2; col <= 6; col++) {
            if (sqlite3_column_type(stmt, col) != SQLITE_TEXT || sqlite3_column_bytes(stmt, col) > 4096) goto done;
            NSData *bytes = [NSData dataWithBytes:sqlite3_column_text(stmt, col) length:sqlite3_column_bytes(stmt, col)];
            NSString *value = [[NSString alloc] initWithData:bytes encoding:NSUTF8StringEncoding];
            if (!value || [value rangeOfString:@"\0"].location != NSNotFound) goto done;
            [texts addObject:value];
        }
        [songs addObject:@{@"songid": [NSString stringWithFormat:@"%lld", sqlite3_column_int64(stmt, 0)],
            @"storageType": @(sqlite3_column_int64(stmt, 1)), @"name": texts[0], @"singer": texts[1],
            @"album": texts[2], @"songmid": texts[3], @"albumMid": texts[4], @"durationMs": @(sqlite3_column_int64(stmt, 7))}];
    }
    if (result == SQLITE_DONE) failure = nil;
done:
    if (stmt) sqlite3_finalize(stmt);
    if (db) sqlite3_close(db);
    return failure ? @{@"error": failure} : @{@"schema": @"qqmusic-songs-v1", @"songs": songs};
}

static int read_local_song(NSString *path) {
    @autoreleasepool {
        NSData *input = [NSFileHandle.fileHandleWithStandardInput readDataOfLength:16385];
        id request = input.length <= 16384 ? [NSJSONSerialization JSONObjectWithData:input options:0 error:nil] : nil;
        id title = [request isKindOfClass:NSDictionary.class] ? request[@"title"] : nil;
        BOOL valid = [title isKindOfClass:NSString.class] && [title length] > 0 && [title length] <= 1024
            && [title rangeOfString:@"\0"].location == NSNotFound;
        NSDictionary *result = valid ? lookup(path, title) : @{@"error": @"invalid-local-query"};
        NSData *output = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
        if (!output) return 1;
        fwrite(output.bytes, 1, output.length, stdout); puts("");
        return 0;
    }
}

int zcode_local_song(void) {
    return read_local_song([NSHomeDirectory() stringByAppendingPathComponent:
        @"Library/Containers/com.tencent.QQMusicMac/Data/Library/Application Support/QQMusicMac/qqmusic.sqlite"]);
}

#ifdef ZCODE_MUSIC_LOCAL_TEST
// Only the standalone test executable accepts an alternate database path.
int main(int argc, const char *argv[]) {
    @autoreleasepool { return argc == 2 ? read_local_song(@(argv[1])) : 1; }
}
#endif
