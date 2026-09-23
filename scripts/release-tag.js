export function publishTagForVersion(version) {
	const prerelease = /^\d+\.\d+\.\d+-([a-z][a-z0-9-]*)(?:\.|$)/i.exec(version)?.[1]
	if (version.includes('-') && !prerelease) {
		throw new Error(`Unsupported prerelease version: ${version}`)
	}
	return prerelease ?? 'latest'
}
