import { MessageProcessor, NodeResolver, ResolvedBinding, getValue } from "@a2ui/web_core";
import { basicCatalog } from "@a2ui/web_core/catalogs/basic/v1";
import { isAvatarUrl } from "./avatar-url.mjs";
export { pullRequestViews } from "./pr-view.mjs";
export { saveView, loadView } from "./artifacts.mjs";

const supported = new Set(["Column", "Row", "Text", "Divider", "Button", "Image"]);
function navigation(url) {
  if (
    typeof url !== "string" ||
    !/^https:\/\/github\.com\/(?:apps\/[A-Za-z0-9-]{1,100}|[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\/[A-Za-z0-9_.-]{1,100}\/(?:pull\/[1-9]\d*|pulls))?)$/.test(
      url,
    )
  )
    throw new Error("unsupported_url");
  return url;
}
function literalOrPath(value) {
  return (
    typeof value === "string" ||
    (value && typeof value === "object" && Object.keys(value).length === 1 && typeof value["@path"] === "string")
  );
}

// This is a snapshot adapter, not a second A2UI interpreter. Official Core owns protocol validation and binding scopes.
export async function renderA2ui(view, { image } = {}) {
  const message = view?.messages?.[0],
    surface = message?.createSurface;
  if (
    typeof view?.title !== "string" ||
    view.title.length > 200 ||
    view.messages.length !== 1 ||
    message.version !== "1.0" ||
    !surface ||
    surface.catalogId !== basicCatalog.id ||
    !Array.isArray(surface.components) ||
    surface.components.length > 500
  )
    throw new Error("unsupported_a2ui_surface");
  for (const c of surface.components) {
    if (!supported.has(c.component)) throw new Error("unsupported_a2ui_component");
    if (c.component === "Text" && !literalOrPath(c.text)) throw new Error("unsupported_a2ui_binding");
    if (c.component === "Image" && (c.variant !== "avatar" || !literalOrPath(c.url)))
      throw new Error("unsupported_a2ui_image");
    if (c.component === "Button") {
      const call = c.action?.functionCall;
      if (
        Object.keys(c.action).length !== 1 ||
        call?.["@call"] !== "openUrl" ||
        Object.keys(call).some((k) => !["@call", "args"].includes(k)) ||
        Object.keys(call.args || {}).length !== 1 ||
        !literalOrPath(call.args?.url)
      )
        throw new Error("unsupported_a2ui_action");
    }
  }
  const processor = new MessageProcessor([basicCatalog], undefined, { version: "v1.0" });
  let resolver;
  try {
    await processor.processMessages(view.messages);
    resolver = new NodeResolver(processor.model.getSurface(surface.surfaceId));
    const definitions = new Map(surface.components.map((c) => [c.id, c]));
    const render = async (node) => {
      if (!node || node.state !== "resolved") throw new Error("unresolved_a2ui_component");
      const p = getValue(node.props);
      switch (node.type) {
        case "Column":
          return (await Promise.all(p.children.map(render))).flat();
        case "Row":
          return [
            {
              tag: "column_set",
              flex_mode: "flow",
              horizontal_spacing: "8px",
              columns: (
                await Promise.all(
                  p.children.map(async (child) => ({
                    tag: "column",
                    width: child.type === "Image" ? "auto" : "weighted",
                    weight: 1,
                    vertical_align: "center",
                    elements: await render(child),
                  })),
                )
              ).filter((c) => c.elements.length),
            },
          ];
        case "Divider":
          return [{ tag: "hr" }];
        case "Text": {
          const text = p.text instanceof ResolvedBinding ? p.text.value : p.text;
          if (typeof text !== "string") throw new Error("unresolved_a2ui_text");
          return [
            {
              tag: "div",
              text: { tag: "plain_text", content: text, text_size: p.variant === "caption" ? "notation" : "normal" },
            },
          ];
        }
        case "Button": {
          const label = await render(p.child);
          if (label.length !== 1 || label[0].tag !== "div") throw new Error("unsupported_button_child");
          const raw = definitions.get(node.componentId).action.functionCall.args.url;
          const url = navigation(node.context.dataContext.resolveDynamicValue(raw));
          return [
            {
              tag: "button",
              type: p.variant === "primary" ? "primary" : "default",
              text: { tag: "plain_text", content: label[0].text.content },
              behaviors: [{ type: "open_url", default_url: url }],
            },
          ];
        }
        case "Image": {
          const url = p.url instanceof ResolvedBinding ? p.url.value : p.url;
          if (!isAvatarUrl(url)) throw Error("unsupported_avatar_url");
          const key = await image?.(url);
          if (!key) return [];
          if (!/^img_[\w-]+$/.test(key)) throw Error("invalid_image_key");
          const description = p.description instanceof ResolvedBinding ? p.description.value : p.description;
          return [
            {
              tag: "img",
              img_key: key,
              alt: { tag: "plain_text", content: description || "作者头像" },
              size: "small",
              scale_type: "crop_center",
              corner_radius: "50%",
              preview: false,
            },
          ];
        }
        default:
          throw new Error("unsupported_a2ui_component");
      }
    };
    return {
      schema: "2.0",
      config: { wide_screen_mode: true },
      header: { template: "blue", title: { tag: "plain_text", content: view.title } },
      body: { elements: await render(getValue(resolver.rootNode)) },
    };
  } finally {
    resolver?.dispose();
    processor.dispose();
  }
}
