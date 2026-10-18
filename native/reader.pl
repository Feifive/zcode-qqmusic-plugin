#!/usr/bin/perl
use strict;
use warnings;
use DynaLoader;

# Load only the exact library path bundled by the plugin. No eval, shell,
# external modules, or downloaded code. See mediaremote-adapter's DynaLoader
# approach for compatibility with macOS 15.4 and later.
my $path = shift @ARGV or die "Missing media adapter library\n";
die "Unexpected arguments\n" if @ARGV;
my $handle = DynaLoader::dl_load_file($path, 0)
  or die "Could not load media adapter: " . DynaLoader::dl_error() . "\n";
my $entry = DynaLoader::dl_find_symbol($handle, 'zcode_media_entry')
  or die "Media adapter entry is missing\n";
DynaLoader::dl_install_xsub('main::zcode_media_entry', $entry);
zcode_media_entry();
