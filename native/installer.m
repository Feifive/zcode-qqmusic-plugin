#import <Cocoa/Cocoa.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>

static NSString *selectedApp;
static NSString *selectedBackup;
static NSString *chooseApp(NSString *message) {
  NSOpenPanel *panel=[NSOpenPanel openPanel];
  panel.message=message; panel.canChooseFiles=YES;panel.canChooseDirectories=NO;panel.allowsMultipleSelection=NO;
  panel.allowedContentTypes=@[UTTypeApplicationBundle];panel.directoryURL=[NSURL fileURLWithPath:@"/Applications"];
  return [panel runModal]==NSModalResponseOK?panel.URL.path:nil;
}
static void execute(NSString *action) {
  NSString *runtime=[selectedApp stringByAppendingPathComponent:@"Contents/Frameworks/ZCode Helper.app/Contents/MacOS/ZCode Helper"];
  if(![[NSFileManager defaultManager]isExecutableFileAtPath:runtime]) {
    NSAlert *a=[NSAlert new];a.messageText=@"没有找到 ZCode 运行时";a.informativeText=@"请选择已安装的官方 ZCode.app。";[a runModal];return;
  }
  NSAlert *progress=[NSAlert new];progress.messageText=@"正在处理…";progress.informativeText=@"首次安装会备份 ZCode 并安装加载器。后续更新仅替换插件文件。";
  [progress addButtonWithTitle:@"请稍候"];progress.buttons.firstObject.enabled=NO;
  NSProgressIndicator *spinner=[[NSProgressIndicator alloc]initWithFrame:NSMakeRect(0,0,260,20)];spinner.style=NSProgressIndicatorStyleBar;spinner.indeterminate=YES;[spinner startAnimation:nil];progress.accessoryView=spinner;
  __block NSString *result;__block int status=1;
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0),^{
    @try {
      NSTask *task=[NSTask new];task.executableURL=[NSURL fileURLWithPath:runtime];
      NSMutableArray *args=[NSMutableArray arrayWithArray:@[[[[NSBundle mainBundle]resourcePath]stringByAppendingPathComponent:@"scripts/manage.mjs"],action,@"--app",selectedApp]];
      if(selectedBackup)[args addObjectsFromArray:@[@"--backup",selectedBackup]];
      task.arguments=args;
      NSMutableDictionary *environment=[[[NSProcessInfo processInfo]environment]mutableCopy];environment[@"ELECTRON_RUN_AS_NODE"]=@"1";task.environment=environment;
      NSPipe *pipe=[NSPipe pipe];task.standardOutput=pipe;task.standardError=pipe;
      NSError *error;
      if([task launchAndReturnError:&error]){NSData *data=[pipe.fileHandleForReading readDataToEndOfFile];[task waitUntilExit];status=task.terminationStatus;result=[[NSString alloc]initWithData:data encoding:NSUTF8StringEncoding];}
      else result=error.localizedDescription;
    } @catch(NSException *e) {result=e.reason;}
    dispatch_async(dispatch_get_main_queue(),^{[NSApp abortModal];[progress.window orderOut:nil];});
  });
  [progress runModal];
  if([result containsString:@"LEGACY_BACKUP_REQUIRED"]){selectedBackup=chooseApp(@"请选择第一次安装插件时备份的原始 ZCode.app（backup/ZCode.app）");if(selectedBackup)execute(action);return;}
  NSAlert *done=[NSAlert new];done.messageText=status==0?@"处理完成":@"操作未完成";
  NSData *data=[result dataUsingEncoding:NSUTF8StringEncoding];NSDictionary *json=data?[NSJSONSerialization JSONObjectWithData:data options:0 error:nil]:nil;
  done.informativeText=json[@"message"]?:result?:@"未知错误";
  if(status==0&&![action isEqualToString:@"uninstall"]){[done addButtonWithTitle:@"打开 ZCode"];[done addButtonWithTitle:@"完成"];if([done runModal]==NSAlertFirstButtonReturn)[[NSWorkspace sharedWorkspace]openURL:[NSURL fileURLWithPath:selectedApp]];}
  else [done runModal];
}
@interface MusicInstallerDelegate : NSObject <NSApplicationDelegate>
@end
@implementation MusicInstallerDelegate
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  [NSApp activateIgnoringOtherApps:YES];
  selectedApp=@"/Applications/ZCode.app";
  if(![[NSFileManager defaultManager]fileExistsAtPath:selectedApp]){selectedApp=chooseApp(@"请选择已安装的官方 ZCode.app");if(!selectedApp){[NSApp terminate:nil];return;}}
  NSAlert *menu=[NSAlert new];menu.messageText=@"ZCode Music";menu.informativeText=@"首次使用请先退出 ZCode，然后安装。之后可在歌词设置中检查更新；ZCode 官方升级后可用本工具修复。\n\n卸载会恢复原包，并保留插件设置和备份。";
  [menu addButtonWithTitle:@"安装 / 修复"];[menu addButtonWithTitle:@"检查并更新"];[menu addButtonWithTitle:@"卸载"];[menu addButtonWithTitle:@"退出"];
  NSInteger choice=[menu runModal]-NSAlertFirstButtonReturn;
  if(choice==0)execute(@"install");else if(choice==1)execute(@"update");else if(choice==2)execute(@"uninstall");
  [NSApp terminate:nil];
}
@end
int main(int argc,const char *argv[]) {@autoreleasepool {
  [NSApplication sharedApplication];[NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
  MusicInstallerDelegate *delegate=[MusicInstallerDelegate new];[NSApp setDelegate:delegate];
  [NSApp run];return 0;
}}
