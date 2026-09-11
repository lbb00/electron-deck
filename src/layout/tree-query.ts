/**
 * Read-only tree queries — the single authority for locating nodes/panels in a
 * layout tree. PURE TS (types only): the mutation layer and the react renderer
 * both consume these so the same traversal is never re-implemented per caller.
 */
import type { LayoutNode, TabGroupNode } from './types.js'

/** The tab-group node with `groupId`, or null. */
export function findGroupById(root: LayoutNode, groupId: string): TabGroupNode | null {
	if (root.kind === 'tabs') {
		return root.id === groupId ? root : null
	}
	for (let i = 0; i < root.children.length; i++) {
		const found = findGroupById(root.children[i]!, groupId)
		if (found !== null) return found
	}
	return null
}

/** The tab-group node that holds `panelId`, or null. */
export function findGroupContaining(root: LayoutNode, panelId: string): TabGroupNode | null {
	if (root.kind === 'tabs') {
		return root.panels.includes(panelId) ? root : null
	}
	for (let i = 0; i < root.children.length; i++) {
		const found = findGroupContaining(root.children[i]!, panelId)
		if (found !== null) return found
	}
	return null
}

/** The id of the tab group currently holding `panelId`, or `undefined` if the
 * panel is not in the tree. Used to detect a drop back into the dragged panel's
 * own group and to guard a vanished split anchor. */
export function findPanelGroupId(root: LayoutNode, panelId: string): string | undefined {
	return findGroupContaining(root, panelId)?.id
}

/** Total panels anywhere in the tree. Drives last-panel close suppression: a
 * group view knows only its own node, so the caller computes this global count. */
export function countPanels(node: LayoutNode): number {
	if (node.kind === 'tabs') return node.panels.length
	let sum = 0
	for (let i = 0; i < node.children.length; i++) {
		sum += countPanels(node.children[i]!)
	}
	return sum
}
