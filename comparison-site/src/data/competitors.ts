/**
 * List of Figma plugins to compare against in the comparison site.
 * Each entry captures the plugin name, Figma Community URL, and a brief description.
 */

export interface CompetitorPlugin {
  name: string;
  url: string;
  website: string;
  description: string;
  category: string;
}

export const competitors: CompetitorPlugin[] = [
  {
    name: "UX Pilot – AI UI Generator & AI Wireframe Generator",
    url: "https://www.figma.com/community/plugin/1257688030051249633/ux-pilot-ai-ui-generator-ai-wireframe-generator",
    website: "https://uxpilot.ai/",
    description: "AI-powered UI design and wireframe generation directly in Figma. Generates screens from text prompts.",
    category: "AI Design Generation",
  },
  {
    name: "Codia AI – Design to Code",
    url: "https://www.figma.com/community/plugin/1329812760871373657/codia-ai-design-screenshot-to-editable-figma-design",
    website: "https://codia.ai/",
    description: "AI-driven Figma to code conversion supporting React, Flutter, SwiftUI, and more.",
    category: "Design to Code",
  },
  {
    name: "Wireframe Designer",
    url: "https://www.figma.com/community/plugin/1228969298040149016/wireframe-designer",
    website: "",
    description: "AI-powered wireframe generation plugin for Figma.",
    category: "AI Design Generation",
  },
];
