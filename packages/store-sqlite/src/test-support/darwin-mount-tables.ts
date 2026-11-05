// darwin-mount-tables.ts — issue #616 PR-1a unit 5: test fixtures, never shipped (the package's
// `files` leaves `dist/**/test-support/**` out). The mount tables `/sbin/mount` printed on GitHub's
// macos-14, macos-15 and macos-26 runners on 2026-09-28 (the probe run 36425160341), each line as
// printed. On all three the root is `(apfs, sealed, local, read-only, journaled)`, though APFS's type
// number differs between those versions; the gate reads the text, never the number.

/** `/sbin/mount` on GitHub's macos-14 runner (10 mounts). */
export const MOUNT_TABLE_MACOS_14 = [
  '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)',
  'devfs on /dev (devfs, local, nobrowse)',
  '/dev/disk3s6 on /System/Volumes/VM (apfs, local, noexec, journaled, noatime, nobrowse)',
  '/dev/disk3s2 on /System/Volumes/Preboot (apfs, local, journaled, nobrowse)',
  '/dev/disk3s4 on /System/Volumes/Update (apfs, local, journaled, nobrowse)',
  '/dev/disk1s2 on /System/Volumes/xarts (apfs, local, noexec, journaled, noatime, nobrowse)',
  '/dev/disk1s1 on /System/Volumes/iSCPreboot (apfs, local, journaled, nobrowse)',
  '/dev/disk1s3 on /System/Volumes/Hardware (apfs, local, journaled, nobrowse)',
  '/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, protect, root data)',
  'map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)',
].join('\n');

/** `/sbin/mount` on GitHub's macos-15 runner (11 mounts). */
export const MOUNT_TABLE_MACOS_15 = [
  '/dev/disk2s1s1 on / (apfs, sealed, local, read-only, journaled)',
  'devfs on /dev (devfs, local, nobrowse)',
  '/dev/disk2s6 on /System/Volumes/VM (apfs, local, noexec, journaled, noatime, nobrowse)',
  '/dev/disk2s2 on /System/Volumes/Preboot (apfs, local, journaled, nobrowse)',
  '/dev/disk2s4 on /System/Volumes/Update (apfs, local, journaled, nobrowse)',
  '/dev/disk1s2 on /System/Volumes/xarts (apfs, local, noexec, journaled, noatime, nobrowse)',
  '/dev/disk1s1 on /System/Volumes/iSCPreboot (apfs, local, journaled, nobrowse)',
  '/dev/disk1s3 on /System/Volumes/Hardware (apfs, local, journaled, nobrowse)',
  '/dev/disk2s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, root data)',
  '/dev/disk4s1 on /System/Library/AssetsV2/com_apple_MobileAsset_PKITrustStore/purpose_auto/6dd55b0d06633a00de6f57ccb910a66a5ba2409a.asset/.AssetData (apfs, sealed, local, read-only, journaled, nobrowse)',
  'map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)',
].join('\n');

/** `/sbin/mount` on GitHub's macos-26 runner (12 mounts). */
export const MOUNT_TABLE_MACOS_26 = [
  '/dev/disk2s1s1 on / (apfs, sealed, local, read-only, journaled)',
  'devfs on /dev (devfs, local, nobrowse)',
  '/dev/disk2s6 on /System/Volumes/VM (apfs, local, noexec, journaled, noatime, nobrowse)',
  '/dev/disk2s2 on /System/Volumes/Preboot (apfs, local, journaled, nobrowse)',
  '/dev/disk2s4 on /System/Volumes/Update (apfs, local, journaled, nobrowse)',
  '/dev/disk1s2 on /System/Volumes/xarts (apfs, local, noexec, journaled, noatime, nobrowse)',
  '/dev/disk1s1 on /System/Volumes/iSCPreboot (apfs, local, journaled, nobrowse)',
  '/dev/disk1s3 on /System/Volumes/Hardware (apfs, local, journaled, nobrowse)',
  '/dev/disk2s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, root data)',
  '/dev/disk4s1 on /System/Library/AssetsV2/com_apple_MobileAsset_UAF_Siri_Understanding/purpose_auto/c10eb90af2d4996616c3cd0f6bac0833eb4925fa.asset/.AssetData (apfs, sealed, local, read-only, journaled, nobrowse)',
  '/dev/disk6s1 on /System/Library/AssetsV2/com_apple_MobileAsset_PKITrustStore/purpose_auto/6dd55b0d06633a00de6f57ccb910a66a5ba2409a.asset/.AssetData (apfs, sealed, local, read-only, journaled, nobrowse)',
  'map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)',
].join('\n');

/** Lines no runner printed, for the cases they show: a network share, and a network share whose mount
 *  point has a space (a mount point split at its first space would then fall to the root, which is local). */
export const MOUNT_LINE_SMB =
  '//guest@nas.local/share on /Volumes/share (smbfs, nodev, nosuid, mounted by runner)';
export const MOUNT_LINE_SPACES =
  '//guest@nas.local/Team Share on /Volumes/Team Share (smbfs, nodev, nosuid, mounted by runner)';
