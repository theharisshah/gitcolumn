import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileCog,
  FileImage,
  FileJson,
  FileLock,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  FileVideo,
  Folder,
  FolderOpen,
  Link2,
  Package,
  type LucideIcon,
} from 'lucide-react';

const BY_EXT: Record<string, LucideIcon> = {};
const add = (icon: LucideIcon, exts: string) => exts.split(' ').forEach((e) => (BY_EXT[e] = icon));
add(FileCode, 'js jsx mjs cjs ts tsx mts cts py rb go rs java kt kts swift c h cc cpp cxx hpp m mm cs php vue svelte lua pl r scala dart ex exs erl hs clj elm sql graphql gql css scss sass less html htm xml');
add(FileJson, 'json jsonc json5');
add(FileCog, 'yml yaml toml ini cfg conf env properties editorconfig gitattributes gitignore gitmodules npmrc nvmrc babelrc eslintrc prettierrc');
add(FileTerminal, 'sh bash zsh fish ps1 bat cmd');
add(FileText, 'md markdown txt rst adoc log rtf');
add(FileImage, 'png jpg jpeg gif webp avif bmp ico svg tiff psd ai sketch fig');
add(FileArchive, 'zip tar gz tgz bz2 xz 7z rar jar war dmg pkg deb rpm');
add(FileAudio, 'mp3 wav flac aac ogg m4a');
add(FileVideo, 'mp4 mov avi mkv webm');
add(FileSpreadsheet, 'csv tsv xls xlsx numbers');
add(FileLock, 'lock pem key crt cer p12');

const BY_NAME: Record<string, LucideIcon> = {
  dockerfile: FileCog,
  makefile: FileTerminal,
  license: FileText,
  'package-lock.json': FileLock,
  'yarn.lock': FileLock,
  'pnpm-lock.yaml': FileLock,
};

export function fileIconFor(path: string): LucideIcon {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  if (BY_NAME[name]) return BY_NAME[name];
  const dot = name.lastIndexOf('.');
  const ext = dot === -1 ? (name.startsWith('.') ? name.slice(1) : '') : name.slice(dot + 1);
  return BY_EXT[ext] ?? (name.startsWith('.') ? BY_EXT[name.slice(1)] ?? FileCog : File);
}

export function FileIcon({
  path,
  type = 'blob',
  open,
  size = 14,
}: {
  path: string;
  type?: 'blob' | 'tree' | 'commit' | 'symlink';
  open?: boolean;
  size?: number;
}) {
  const Icon = type === 'tree' ? (open ? FolderOpen : Folder) : type === 'commit' ? Package : type === 'symlink' ? Link2 : fileIconFor(path);
  return <Icon size={size} className={`file-icon file-icon-${type}`} aria-hidden />;
}
