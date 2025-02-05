import { Notice, Plugin, setIcon, WorkspaceItem, WorkspaceLeaf, WorkspaceSplit, WorkspaceTabs } from 'obsidian';
import { debounce } from 'obsidian';

export default class EditorGroupArrangementPlugin extends Plugin {
  static MIN_HEIGHT_PX = 80;
  static MIN_WIDTH_PX = 200;

  /**
   * if the active editor group is expanded, there is a tab node that has width or height > 200px
  */
  private _isExpandedGroup: boolean = false;

  /**
   * Status bar item to show the current status of the plugin
   */
  private _statusBarItem: HTMLElement | undefined;

  async onload() {
    console.log("obsidian-editor-group-arrangement-plugin loaded");
    this._registerCommands();
    this._registerEventListeners();

    this._statusBarItem = this.addStatusBarItem();
    this._statusBarItem.addClass('mod-clickable');
    this._statusBarItem.onClickEvent(() => {
      this._toggleExpand();
    });
    this._updateUI();
  }

  async onunload() {
    console.log("obsidian-editor-group-arrangement-plugin unloaded");
  }

  private _registerCommands() {
    this.addCommand({
      id: 'arrange-editor-groups-evenly',
      name: 'Arrange Evenly',
      callback: () => {
        this._arrangeEvenly();
      },
      hotkeys: []
    });

    this.addCommand({
      id: 'arrange-editor-groups-expand-active',
      name: 'Expand Active Editor',
      callback: () => {
        this._expandActiveLeaf();
      },
      hotkeys: []
    });

    this.addCommand({
      id: 'arrange-editor-groups-toggle-expand',
      name: 'Toggle Expand Active Editor',
      callback: () => {
        this._toggleExpand();
      },
      hotkeys: [],
    })

    // TODO feature to be implemented in the future
    // this.addCommand({
    //   id: 'arrange-editor-groups-collapse-maximize-active',
    //   name: 'Maximize Active Editor',
    //   callback: () => {
    //     // TODO
    //   },
    //   hotkeys: []
    // })
  }

  private _registerEventListeners() {
    this.registerDomEvent(document, 'click', (event) => {
      const target = event.target as HTMLElement;
      if (!target.closest('.mod-root')) return;

      if (this._isExpandedGroup) {
        const closestElem = target.closest('.workspace-tab-header')
        if (closestElem) {
          this._expandActiveLeaf();
        }
      }
    });

    // TODO buggy: when we double on tab, the electron window will resize before the plugin can handle the event, and we cannot prevent it
    // this.registerDomEvent(document, 'dblclick', (event) => {
    //   const target = event.target as HTMLElement;
    //   if (!target.closest('.mod-root')) return;

    //   // check if it is in or is a tab item. class name of tab item is "workspace-tab-header" and "tappable"
    //   const closestElem = target.closest('.workspace-tab-header')
    //   if (closestElem) {
    //     // to prevent the default behavior of double click, which is to resize the window
    //     event.stopPropagation();
    //     event.preventDefault();

    //     this._toggleExpand();
    //   }
    // });

    this.app.workspace.on('active-leaf-change', (leaf) => {
      // TODO buggy, it you create a new split node from tab node that exists in other split, it will not work. Since the active leaf is not changed...
      // FIXME: maybe we can listen to layout-change event
      if (this._isExpandedGroup && leaf && this._isLeafUnderRootSplit(leaf)) {
        this._expandActiveLeaf(leaf);
      }
    });

    this.registerDomEvent(window, 'resize', debounce(() => {
      if (this._isExpandedGroup) {
        this._expandActiveLeaf();
      }
    }, 100));
  }

  private _updateUI() {
    if (this._isExpandedGroup) {
      setIcon(this._statusBarItem!, 'expand');

      // set aria-label to make it accessible
      this._statusBarItem!.setAttribute('aria-label', 'Editor arrangement: Expanded');
      // new Notice('Editor group arrangement is set to expanded');
    } else {
      setIcon(this._statusBarItem!, 'shrink');

      // set aria-label to make it accessible
      this._statusBarItem!.setAttribute('aria-label', 'Editor arrangement: Normal');

      // new Notice('Editor group arrangement is reset to normal');
    }
    this._statusBarItem!.setAttribute('data-tooltip-position', 'top');
  }

  private _toggleExpand() {
    if (this._isExpandedGroup) {
      this._arrangeEvenly();
    } else {
      this._expandActiveLeaf();
    }
  }

  private _collectedNonLeafNodes() {
    const collectedNonLeafNodes: Set<WorkspaceItem> = new Set();
    this.app.workspace.iterateRootLeaves((leaf) => {
      let parent = leaf.parent;

      while (parent) {
        if (parent === this.app.workspace.rootSplit) {
          break;
        }
        if (collectedNonLeafNodes.has(parent)) {
          break;
        }

        collectedNonLeafNodes.add(parent);

        parent = parent.parent;
      }
    });

    return collectedNonLeafNodes;
  }

  /**
   * Remove all flex-grow style from node with type "tabs" and "split"
   */
  private _arrangeEvenly() {
    const collectedNonLeafNodes = this._collectedNonLeafNodes();

    collectedNonLeafNodes.forEach((node) => {
      // @ts-ignore. Since it is a private property
      const el = node.containerEl as HTMLElement;
      if (!el) return;
      el.style.flexGrow = '';
    });

    this._isExpandedGroup = false;
    this._updateUI();
  }

  /**
   * Get the path ascendants of a node (not including the root node)
   */
  private _getPathAscendants(node: WorkspaceLeaf): Array<WorkspaceItem> {
    const pathAscendants: Array<WorkspaceItem> = [];
    let parent = node.parent;
    while (parent) {
      if (parent === this.app.workspace.rootSplit) {
        break;
      }

      pathAscendants.push(parent);
      parent = parent.parent;
    }

    return pathAscendants;
  }

  private _isLeafUnderRootSplit(leaf: WorkspaceItem): boolean {
    let parent = leaf.parent;
    while (parent) {
      if (parent === this.app.workspace.rootSplit) {
        return true;
      }
      parent = parent.parent;
    }

    return false;
  }

  /**
   * Enlarge the active tab node and shrink the rest to a minimum size
   */
  private _expandActiveLeaf(leaf?: WorkspaceLeaf) {
    const activeLeaf = leaf || this.app.workspace.activeLeaf;
    if (
      !activeLeaf
      || !this._isLeafUnderRootSplit(activeLeaf)
    ) {
      new Notice('Cursor or focus is not in any editor');
      return;
    };

    /**
     * calculate the minimum size for each tab node and split node, in a bottom-up manner
     * 
     * the size(width and height) will be saved in @param minSizeMap
     */
    function doRecurForSizeCalculation(root: WorkspaceItem, minSizeMap: Map<WorkspaceItem, [number, number]>): [number, number] {
      if (root instanceof WorkspaceSplit) {
        // @ts-ignore Since it is a private property
        const children = root.children;
        for (const child of children) {
          const [width, height] = doRecurForSizeCalculation(child, minSizeMap);
          minSizeMap.set(child, [width, height]);
        }

        // get horizontal or vertical split, then calculate the minimum size for this split node itself
        // @ts-ignore Since it is a private property
        const isVertical = root.direction === "vertical";
        // @ts-ignore Since it is a private property
        const isHorizontal = root.direction === "horizontal";

        let minSizeOfCurrentNode = [0, 0];
        for (const child of children) {
          const [width, height] = minSizeMap.get(child)!;
          if (isVertical) {
            minSizeOfCurrentNode = [minSizeOfCurrentNode[0] + width, Math.max(minSizeOfCurrentNode[1], height)];
          } else if (isHorizontal) {
            minSizeOfCurrentNode = [Math.max(minSizeOfCurrentNode[0], width), minSizeOfCurrentNode[1] + height];
          } else {
            throw new Error('Unexpected direction');
          }
        }

        return [minSizeOfCurrentNode[0], minSizeOfCurrentNode[1]];
      } else {
        // reach the bottom, time to return. Here, we ensure bottom is a tab node
        if (!(root instanceof WorkspaceTabs)) throw new Error('Unexpected node type'); // TODO show error message
        return [EditorGroupArrangementPlugin.MIN_WIDTH_PX, EditorGroupArrangementPlugin.MIN_HEIGHT_PX];
      }
    }

    /**
     * Resize based on the minimum size calculated before.
     * 
     * After resizing, the expanded node should have a large enough size, and the rest should have a minimum size.
     */
    function doRecurForResize(root: WorkspaceItem, minSizeMap: Map<WorkspaceItem, [number, number]>, pathAscendants: Array<WorkspaceItem>) {
      if (!(root instanceof WorkspaceSplit)) return;

      // @ts-ignore Since it is a private property
      const children = root.children;

      // @ts-ignore Since it is a private property
      const containerEl = root.containerEl as HTMLElement;
      const containerSize = containerEl.getBoundingClientRect();
      let containerWidth = containerSize.width;
      let containerHeight = containerSize.height;

      // get horizontal or vertical split, then calculate the minimum size for this split node itself
      // @ts-ignore Since it is a private property
      const isVertical = root.direction === "vertical";
      // @ts-ignore Since it is a private property
      const isHorizontal = root.direction === "horizontal";

      // sum up the width or height of non-path nodes
      let weightOrHeightOfNonPathNode = 0;
      console.log('pathAscendants', pathAscendants);
      for (const child of children) {
        console.log('child', child);
        // On the path or it is a leaf node
        if (
          pathAscendants.includes(child)
          || child instanceof WorkspaceLeaf
        ) {
          continue;
        }

        console.log('filtered child', child);


        const [width, height] = minSizeMap.get(child)!;
        if (isVertical) {
          weightOrHeightOfNonPathNode += width;
        } else if (isHorizontal) {
          weightOrHeightOfNonPathNode += height;
        } else {
          throw new Error('Unexpected direction');
        }
      }

      let weightOrHeightOfPathNode = 0;
      if (isVertical) {
        weightOrHeightOfPathNode = containerWidth - weightOrHeightOfNonPathNode;
      } else if (isHorizontal) {
        weightOrHeightOfPathNode = containerHeight - weightOrHeightOfNonPathNode;
      } else {
        throw new Error('Unexpected direction');
      }

      // ensure the minimum size
      weightOrHeightOfPathNode = Math.max(weightOrHeightOfPathNode,
        isHorizontal ? EditorGroupArrangementPlugin.MIN_HEIGHT_PX : EditorGroupArrangementPlugin.MIN_WIDTH_PX
      );
      
      // transform px to percentage
      const isPathNodeExist = (children as WorkspaceItem[]).some((child: WorkspaceItem) => pathAscendants.includes(child));
      const flexGrowOfPathNode = 100 * weightOrHeightOfPathNode / (weightOrHeightOfPathNode + weightOrHeightOfNonPathNode);
      const flexGrowOfNonPathNode = isPathNodeExist
        ? (100 * weightOrHeightOfNonPathNode / (weightOrHeightOfPathNode + weightOrHeightOfNonPathNode)) / Math.max(children.length - 1, 1)
        : (100 * weightOrHeightOfNonPathNode / (weightOrHeightOfNonPathNode)) / Math.max(children.length, 1)

      // set flexGrow for each child
      for (const child of children) {
        const containerEl = child.containerEl as HTMLElement;
        if (pathAscendants.includes(child)) {
          containerEl.style.flexGrow = flexGrowOfPathNode.toString();
        } else {
          containerEl.style.flexGrow = flexGrowOfNonPathNode.toString();
        }
        doRecurForResize(child, minSizeMap, pathAscendants);
      }
    }

    const rootNode = this.app.workspace.rootSplit;
    const minSizeMap = new Map<WorkspaceItem, [number, number]>();
    const pathAscendants = this._getPathAscendants(activeLeaf);

    const rootSize = doRecurForSizeCalculation(rootNode, minSizeMap);
    minSizeMap.set(rootNode, [rootSize[0], rootSize[1]]);

    // TODO if small root split is small, we need to handle it differently
    doRecurForResize(rootNode, minSizeMap, pathAscendants);

    this._isExpandedGroup = true;
    this._updateUI();
  }
}
