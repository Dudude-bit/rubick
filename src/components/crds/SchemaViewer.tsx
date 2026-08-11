import { useState, useMemo } from "react";
import {
  ChevronDown,
  ChevronRight,
  Hash,
  Type,
  List,
  Braces,
  ToggleLeft,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface SchemaViewerProps {
  schema: unknown;
  title?: string;
}

interface SchemaProperty {
  type?: string;
  description?: string;
  properties?: Record<string, SchemaProperty>;
  items?: SchemaProperty;
  required?: string[];
  enum?: string[];
  default?: unknown;
  format?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  additionalProperties?: boolean | SchemaProperty;
  oneOf?: SchemaProperty[];
  anyOf?: SchemaProperty[];
  allOf?: SchemaProperty[];
  $ref?: string;
  "x-kubernetes-preserve-unknown-fields"?: boolean;
}

interface SchemaNodeProps {
  name: string;
  schema: SchemaProperty;
  required?: boolean;
  level: number;
  defaultExpanded?: boolean;
}

function getTypeIcon(type: string | undefined) {
  switch (type) {
    case "string":
      return <Type className="h-3 w-3" />;
    case "number":
    case "integer":
      return <Hash className="h-3 w-3" />;
    case "boolean":
      return <ToggleLeft className="h-3 w-3" />;
    case "array":
      return <List className="h-3 w-3" />;
    case "object":
      return <Braces className="h-3 w-3" />;
    default:
      return <Braces className="h-3 w-3" />;
  }
}

/**
 * Four role colours cover six JSON types, which is fine: the type name is
 * printed next to every field and the icon differs per type, so the hue is
 * the third cue rather than the only one. Inventing a purple and an orange
 * for `boolean` and `array` would be two colours the theme cannot honour.
 */
function getTypeColor(type: string | undefined): string {
  switch (type) {
    case "string":
      return "text-ok";
    case "number":
    case "integer":
      return "text-info";
    case "boolean":
      return "text-warn";
    case "array":
    case "object":
      return "text-fg-mid";
    default:
      return "text-fg-fnt";
  }
}

function formatType(schema: SchemaProperty): string {
  if (schema.$ref) {
    return schema.$ref.split("/").pop() || "ref";
  }
  if (schema.oneOf) {
    return "oneOf";
  }
  if (schema.anyOf) {
    return "anyOf";
  }
  if (schema.type === "array" && schema.items) {
    return `array<${formatType(schema.items)}>`;
  }
  return schema.type || "unknown";
}

function SchemaNode({
  name,
  schema,
  required,
  level,
  defaultExpanded = false,
}: SchemaNodeProps) {
  const [expanded, setExpanded] = useState(defaultExpanded || level < 2);

  const hasChildren = useMemo(() => {
    return (
      (schema.type === "object" &&
        schema.properties &&
        Object.keys(schema.properties).length > 0) ||
      (schema.type === "array" && schema.items?.properties) ||
      schema.oneOf ||
      schema.anyOf ||
      schema.allOf
    );
  }, [schema]);

  const childProperties = useMemo(() => {
    if (schema.type === "object" && schema.properties) {
      return Object.entries(schema.properties);
    }
    if (schema.type === "array" && schema.items?.properties) {
      return Object.entries(schema.items.properties);
    }
    return [];
  }, [schema]);

  const requiredFields = useMemo(() => {
    if (schema.type === "object") {
      return new Set(schema.required || []);
    }
    if (schema.type === "array" && schema.items) {
      return new Set(schema.items.required || []);
    }
    return new Set<string>();
  }, [schema]);

  return (
    <div className="font-mono text-xs">
      {/* Node header */}
      <div
        className={cn(
          "flex cursor-pointer items-start gap-2 rounded px-2 py-0.5 hover:bg-hover",
          level > 0 && "ml-4"
        )}
        onClick={() => hasChildren && setExpanded(!expanded)}
        style={{ paddingLeft: `${level * 16 + 8}px` }}
      >
        {/* Expand/collapse icon */}
        <span className="w-4 h-4 flex items-center justify-center flex-shrink-0 mt-0.5">
          {hasChildren ? (
            expanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )
          ) : null}
        </span>

        {/* Type icon */}
        <span className={cn("flex-shrink-0 mt-0.5", getTypeColor(schema.type))}>
          {getTypeIcon(schema.type)}
        </span>

        {/* Property name */}
        <span className="font-medium text-fg">{name}</span>

        {required && <span className="text-[10px] text-err">required</span>}

        {/* Type */}
        <span className={cn("text-[11px]", getTypeColor(schema.type))}>
          {formatType(schema)}
        </span>

        {/* Format */}
        {schema.format && (
          <span className="text-[11px] text-fg-fnt">({schema.format})</span>
        )}

        {/* Enum values */}
        {schema.enum && (
          <span className="text-[11px] text-fg-fnt">
            [{schema.enum.slice(0, 3).join(", ")}
            {schema.enum.length > 3 && "..."}]
          </span>
        )}

        {/* Default value */}
        {schema.default !== undefined && (
          <span className="text-[11px] text-fg-fnt">
            = {JSON.stringify(schema.default)}
          </span>
        )}
      </div>

      {/* Description */}
      {schema.description && (
        <div
          className="mb-1 ml-8 text-[11px] text-fg-mut"
          style={{ paddingLeft: `${level * 16 + 8}px` }}
        >
          {schema.description}
        </div>
      )}

      {/* Constraints */}
      {(schema.minimum !== undefined ||
        schema.maximum !== undefined ||
        schema.minLength !== undefined ||
        schema.maxLength !== undefined ||
        schema.pattern) && (
        <div
          className="mb-1 ml-8 flex gap-2 text-[11px] text-fg-fnt"
          style={{ paddingLeft: `${level * 16 + 8}px` }}
        >
          {schema.minimum !== undefined && <span>min: {schema.minimum}</span>}
          {schema.maximum !== undefined && <span>max: {schema.maximum}</span>}
          {schema.minLength !== undefined && (
            <span>minLength: {schema.minLength}</span>
          )}
          {schema.maxLength !== undefined && (
            <span>maxLength: {schema.maxLength}</span>
          )}
          {schema.pattern && <span>pattern: /{schema.pattern}/</span>}
        </div>
      )}

      {/* Children */}
      {expanded && hasChildren && (
        <div
          className="ml-4 border-l border-hair"
          style={{ marginLeft: `${level * 16 + 16}px` }}
        >
          {/* Object properties */}
          {childProperties.map(([propName, propSchema]) => (
            <SchemaNode
              key={propName}
              name={propName}
              schema={propSchema}
              required={requiredFields.has(propName)}
              level={level + 1}
            />
          ))}

          {/* oneOf / anyOf / allOf */}
          {(schema.oneOf || schema.anyOf || schema.allOf)?.map(
            (subSchema, i) => (
              <SchemaNode
                key={i}
                name={`option ${i + 1}`}
                schema={subSchema}
                level={level + 1}
              />
            )
          )}

          {/* Additional properties */}
          {schema.additionalProperties === true && (
            <div
              className="py-1 text-[11px] text-fg-fnt"
              style={{ paddingLeft: `${(level + 1) * 16 + 8}px` }}
            >
              (additional properties allowed)
            </div>
          )}
          {typeof schema.additionalProperties === "object" && (
            <SchemaNode
              name="[additionalProperties]"
              schema={schema.additionalProperties}
              level={level + 1}
            />
          )}

          {/* x-kubernetes-preserve-unknown-fields */}
          {schema["x-kubernetes-preserve-unknown-fields"] && (
            <div
              className="py-1 text-[11px] text-fg-fnt"
              style={{ paddingLeft: `${(level + 1) * 16 + 8}px` }}
            >
              (preserves unknown fields)
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function SchemaViewer({ schema, title }: SchemaViewerProps) {
  const parsedSchema = schema as SchemaProperty;

  if (!parsedSchema || typeof parsedSchema !== "object") {
    return (
      <p className="text-xs text-fg-mut">No schema information available.</p>
    );
  }

  // Get the spec schema if available (common for CRDs)
  const specSchema = parsedSchema.properties?.spec as
    | SchemaProperty
    | undefined;
  const statusSchema = parsedSchema.properties?.status as
    | SchemaProperty
    | undefined;

  return (
    <div className="flex flex-col gap-2">
      {title && (
        <h2 className="text-[13px] font-semibold tracking-tight text-fg">
          {title}
        </h2>
      )}

      {specSchema && (
        <section>
          <div className="border-b border-hair px-1 pb-1 text-[10px] font-semibold uppercase tracking-[0.07em] text-fg-fnt">
            spec
          </div>
          <div className="py-1">
            {specSchema.properties ? (
              Object.entries(specSchema.properties).map(
                ([name, propSchema]) => (
                  <SchemaNode
                    key={name}
                    name={name}
                    schema={propSchema}
                    required={specSchema.required?.includes(name)}
                    level={0}
                    defaultExpanded={true}
                  />
                )
              )
            ) : (
              <SchemaNode
                name="spec"
                schema={specSchema}
                level={0}
                defaultExpanded={true}
              />
            )}
          </div>
        </section>
      )}

      {statusSchema && (
        <section>
          <div className="border-b border-hair px-1 pb-1 text-[10px] font-semibold uppercase tracking-[0.07em] text-fg-fnt">
            status
          </div>
          <div className="py-1">
            {statusSchema.properties ? (
              Object.entries(statusSchema.properties).map(
                ([name, propSchema]) => (
                  <SchemaNode
                    key={name}
                    name={name}
                    schema={propSchema}
                    required={statusSchema.required?.includes(name)}
                    level={0}
                  />
                )
              )
            ) : (
              <SchemaNode name="status" schema={statusSchema} level={0} />
            )}
          </div>
        </section>
      )}

      {/* If no spec/status, show root properties */}
      {!specSchema && !statusSchema && parsedSchema.properties && (
        <div className="py-1">
          {Object.entries(parsedSchema.properties).map(([name, propSchema]) => (
            <SchemaNode
              key={name}
              name={name}
              schema={propSchema as SchemaProperty}
              required={parsedSchema.required?.includes(name)}
              level={0}
              defaultExpanded={true}
            />
          ))}
        </div>
      )}

      {/* Fallback for simple schemas */}
      {!parsedSchema.properties && (
        <div className="py-1">
          <SchemaNode
            name="root"
            schema={parsedSchema}
            level={0}
            defaultExpanded={true}
          />
        </div>
      )}
    </div>
  );
}
