import fs from 'node:fs';
import Path from 'node:path';

function rmDirSync(path) {
	if (fs.existsSync(path)) {
		fs.readdirSync(path).forEach((file, index) => {
			const curPath = Path.join(path, file);
			if (fs.lstatSync(curPath).isDirectory()) {
				rmDirSync(curPath);
			} else {
				fs.unlinkSync(curPath);
			}
		});
		fs.rmdirSync(path);
	}
}

const folder = Path.dirname(Path.dirname(process.cwd()));

if (fs.existsSync(`${folder}/dist/public`)) {
	rmDirSync(`${folder}/dist/public`);
}

fs.cpSync(`${process.cwd()}/public`, `${folder}/dist/public`, {recursive: true});

//fs.mkdirSync(`${process.cwd()}/dist`);
//fs.copyFileSync(`${process.cwd()}/package.json`, `${process.cwd()}/dist/package.json`);
//fs.copyFileSync(`${process.cwd()}/README.md`, `${process.cwd()}/dist/README.md`);