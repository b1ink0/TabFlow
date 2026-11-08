// Public documentation data only. No browser history, provider calls or external page fetches.
export function documentationState(state) {
  const now = Date.now();
  const projects = [
    {
      id: 'library',
      name: 'Atlas redesign',
      displayColor: '#8eb8e8',
      purpose: 'Build the next Atlas workspace with accessible, consistent interactions.',
    },
    {
      id: 'garden',
      name: 'Field notes',
      displayColor: '#83b5a0',
      purpose: 'Explore data visualization and the web platform.',
    },
    {
      id: 'personal',
      name: 'Reading room',
      displayColor: '#b19bd4',
      purpose: 'Keep useful articles and references for later.',
    },
  ];
  const categories = [
    ['implementation', 'library', 'Implementation', '#8eb8e8'],
    ['design', 'library', 'Design system', '#c7a1ca'],
    ['accessibility', 'library', 'Accessibility', '#d3b279'],
    ['visualization', 'garden', 'Data visualization', '#83b5a0'],
    ['platform', 'garden', 'Web platform', '#8eb8e8'],
    ['reading', 'personal', 'Articles & references', '#b19bd4'],
  ];
  const tabs = [
    [
      'Nuxt · Introduction',
      'https://nuxt.com/docs/getting-started/introduction',
      'implementation',
      ['nuxt', 'reference'],
      null,
      'Build the workspace',
    ],
    [
      'Nuxt UI · Tree',
      'https://ui.nuxt.com/docs/components/tree',
      'implementation',
      ['components', 'reference'],
      0,
    ],
    [
      'Reka UI · Tree',
      'https://reka-ui.com/docs/components/tree',
      'implementation',
      ['components', 'accessibility'],
      1,
    ],
    [
      'MDN · HTML Drag and Drop API',
      'https://developer.mozilla.org/en-US/docs/Web/API/HTML_Drag_and_Drop_API',
      'implementation',
      ['browser-apis', 'reference'],
      0,
    ],
    [
      'Vue · Reactivity fundamentals',
      'https://vuejs.org/guide/essentials/reactivity-fundamentals.html',
      'implementation',
      ['vue', 'reference'],
      null,
    ],
    [
      'TypeScript · Everyday types',
      'https://www.typescriptlang.org/docs/handbook/2/everyday-types.html',
      'implementation',
      ['typescript', 'reference'],
      null,
    ],
    [
      'Figma Community',
      'https://www.figma.com/community',
      'design',
      ['design', 'inspiration'],
      null,
    ],
    [
      'Inter · Google Fonts',
      'https://fonts.google.com/specimen/Inter',
      'design',
      ['typography', 'design'],
      6,
    ],
    [
      'Material Design · Color',
      'https://m3.material.io/styles/color/overview',
      'design',
      ['design', 'color'],
      6,
    ],
    [
      'WAI-ARIA · Authoring Practices Guide',
      'https://www.w3.org/WAI/ARIA/apg/',
      'accessibility',
      ['accessibility', 'reference'],
      null,
    ],
    [
      'web.dev · Learn accessibility',
      'https://web.dev/learn/accessibility',
      'accessibility',
      ['accessibility', 'reading'],
      9,
    ],
    [
      'MDN · ARIA roles',
      'https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Roles',
      'accessibility',
      ['accessibility', 'reference'],
      9,
    ],
    [
      'Observable Plot · Getting started',
      'https://observablehq.com/plot/getting-started',
      'visualization',
      ['dataviz', 'reference'],
      null,
    ],
    [
      'D3 · Getting started',
      'https://d3js.org/getting-started',
      'visualization',
      ['dataviz', 'javascript'],
      12,
    ],
    [
      'visx · Documentation',
      'https://visx.airbnb.tech/docs',
      'visualization',
      ['dataviz', 'components'],
      null,
    ],
    [
      'MDN · Intersection Observer API',
      'https://developer.mozilla.org/en-US/docs/Web/API/Intersection_Observer_API',
      'platform',
      ['browser-apis', 'reference'],
      null,
    ],
    [
      'Chrome Extensions · Service workers',
      'https://developer.chrome.com/docs/extensions/develop/concepts/service-workers',
      'platform',
      ['extensions', 'reference'],
      15,
    ],
    [
      'web.dev · Rendering performance',
      'https://web.dev/articles/rendering-performance',
      'reading',
      ['performance', 'reading'],
      null,
    ],
    [
      'JavaScript.info · Event loop',
      'https://javascript.info/event-loop',
      'reading',
      ['javascript', 'reading'],
      null,
    ],
    ['Nuxt · Community', 'https://nuxt.com/community', 'reading', ['nuxt', 'open-source'], null],
  ];
  const template = state.records[0];
  state.projects = projects.map((project) => ({ ...project, updatedAt: now, revision: 1 }));
  state.categories = categories.map(([id, projectId, name, displayColor], order) => ({
    id,
    projectId,
    name,
    displayColor,
    description: '',
    order,
    revision: 1,
    updatedAt: now,
  }));
  state.records = tabs.map(([title, url, categoryId, tags, parent, branchName], index) => ({
    ...template,
    id: `record-${index}`,
    title,
    url,
    projectId: categories.find((category) => category[0] === categoryId)[1],
    tabId: index + 10,
    windowId: index % 4 === 0 ? 2 : 1,
    index,
    groupId: -1,
    active: index === 0,
    suspended: ![0, 4, 6, 12].includes(index),
    locked: index === 15,
    tags,
    note: index === 0 ? 'Implementation references for the Atlas redesign.' : '',
    parentRecordId: parent === null ? null : `record-${parent}`,
    branchName: branchName || '',
    content: null,
    lastAccessed: now - index * 3600000,
  }));
  state.memberships = tabs.map((tab, index) => ({
    recordId: `record-${index}`,
    projectId: state.records[index].projectId,
    categoryId: tab[2],
    source: index < 12 ? 'accepted-ai' : 'owner',
    updatedAt: now,
  }));
  state.windows = [
    { id: 1, focused: true, projectId: null },
    { id: 2, focused: false, projectId: null },
  ];
  state.groups = [];
  state.tagVocabulary = [...new Set(tabs.flatMap((tab) => tab[3]))];
  state.collectionProposals = [
    {
      id: 'docs-organization',
      name: 'Atlas launch workspace',
      createdAt: now - 60000,
      status: 'pending',
      decisionContract: 'isolated-evidence-v2',
      summary:
        'Organize the Atlas references into implementation, design and accessibility. Keep existing browser windows.',
      projects: [
        {
          name: 'Atlas redesign',
          purpose: projects[0].purpose,
          areaName: 'Work',
          categories: categories
            .filter((category) => category[1] === 'library')
            .map((category) => ({ name: category[2], description: '' })),
        },
      ],
      assignments: state.records.slice(0, 12).map((record, index) => ({
        recordId: record.id,
        url: record.url,
        navigationVersion: 0,
        projectName: 'Atlas redesign',
        categoryName: categories.find((category) => category[0] === tabs[index][2])[2],
        suggestedTags: record.tags,
        confidence: 0.95,
        reason: 'Reference for the Atlas redesign.',
        status: 'assigned',
      })),
      unresolvedRecordIds: [],
      scopeRecordIds: state.records.slice(0, 12).map((record) => record.id),
    },
  ];
  state.settings.aiModel = 'local-model';
  state.snapshots = [
    {
      id: 'docs-snapshot-1',
      label: 'Atlas: before launch review',
      createdAt: now - 3600000,
      automatic: false,
      windowCount: 2,
      tabCount: 20,
    },
    {
      id: 'docs-snapshot-2',
      label: 'Research session',
      createdAt: now - 86400000,
      automatic: false,
      windowCount: 2,
      tabCount: 18,
    },
    {
      id: 'docs-snapshot-3',
      label: 'Before organization',
      createdAt: now - 172800000,
      automatic: true,
      windowCount: 2,
      tabCount: 16,
    },
  ];
  state.operations = [];
  state.workItems = [];
  state.organizationJobs = [];
  return state;
}

export function documentationIcon(url) {
  const host = new URL(url).hostname;
  const sites = [
    ['nuxt', 'N', '#00a879'],
    ['reka', 'R', '#6855bd'],
    ['vuejs', 'V', '#348762'],
    ['mozilla', 'M', '#202020'],
    ['typescript', 'TS', '#3178c6'],
    ['figma', 'F', '#be5549'],
    ['google', 'G', '#4778bc'],
    ['material', 'M', '#7256a5'],
    ['w3.org', 'W', '#2867a8'],
    ['web.dev', 'W', '#287b55'],
    ['observable', 'O', '#4266a9'],
    ['d3js', 'D3', '#be652b'],
    ['airbnb', 'vx', '#b74e62'],
    ['chrome', 'C', '#4276bd'],
    ['javascript', 'JS', '#897315'],
    ['github', 'GH', '#30343a'],
  ];
  const [, label, color] = sites.find(([match]) => host.includes(match)) || ['', 'W', '#586874'];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="${color}"/><text x="16" y="21" text-anchor="middle" fill="white" font-family="sans-serif" font-weight="700" font-size="${label.length > 1 ? 13 : 20}">${label}</text></svg>`;
}
