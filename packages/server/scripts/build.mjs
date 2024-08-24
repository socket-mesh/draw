import fs from 'node:fs';
import Path from 'node:path';

function rmDirSync(path, ignoreFolder) {
	let hasIgnore = false;

	if (fs.existsSync(path)) {
		fs.readdirSync(path).forEach((file) => {
			const curPath = Path.join(path, file);
			if (fs.lstatSync(curPath).isDirectory()) {
				if (file === ignoreFolder) {
					hasIgnore = true;
				} else {
					rmDirSync(curPath);
				}
			} else {
				fs.unlinkSync(curPath);
			}
		});

		if (!hasIgnore) {
			fs.rmdirSync(path);
		}
	}
}

let folder = Path.dirname(process.cwd());
folder= Path.dirname(folder);

if (fs.existsSync(`${folder}/dist`)) {
	rmDirSync(`${folder}/dist`, 'public');
}

//fs.mkdirSync(`${process.cwd()}/dist`);
fs.copyFileSync(`${process.cwd()}/package.json`, `${folder}/dist/package.json`);