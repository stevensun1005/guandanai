import {execFileSync} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
await mkdir(new URL('../outputs/',import.meta.url),{recursive:true});
const program="from pathlib import Path; import zipfile; r=Path('dist'); z=zipfile.ZipFile('outputs/guandan-web.zip','w',zipfile.ZIP_DEFLATED); [(z.write(p,p.relative_to(r).as_posix())) for p in r.rglob('*') if p.is_file()]; z.close(); print('outputs/guandan-web.zip')";
execFileSync('python',['-c',program],{cwd:root,stdio:'inherit'});
