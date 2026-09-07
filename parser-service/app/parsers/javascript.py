from __future__ import annotations

import logging

from tree_sitter import Language, Parser, Node
import tree_sitter_javascript as tsjs
import tree_sitter_typescript as tsts

from app.schemas import ParseResponse, FunctionFact, ClassFact, ImportFact, CallFact

logger = logging.getLogger(__name__)

# Initialize tree-sitter languages
JS_LANGUAGE = Language(tsjs.language())
TS_LANGUAGE = Language(tsts.language_typescript())
TSX_LANGUAGE = Language(tsts.language_tsx())


def get_parser_for_file(file_path: str, language: str) -> Parser:
    ext = file_path.split(".")[-1].lower() if "." in file_path else ""

    if ext in ("tsx", "jsx"):
        return Parser(TSX_LANGUAGE)
    elif ext in ("ts", "mts", "cts"):
        return Parser(TS_LANGUAGE)
    else:
        return Parser(JS_LANGUAGE)



def parse_js_ts_file(file_path: str, content: str, language_id: str) -> ParseResponse:
    try:
        parser = get_parser_for_file(file_path, language_id)
        code_bytes = content.encode("utf-8")
        tree = parser.parse(code_bytes)
        root = tree.root_node

        functions: list[FunctionFact] = []
        classes: list[ClassFact] = []
        imports: list[ImportFact] = []
        calls: list[CallFact] = []

        def get_node_text(node: Node) -> str:
            return code_bytes[node.start_byte:node.end_byte].decode("utf-8", errors="replace")

        def find_enclosing_function_name(node: Node) -> str:
            current = node.parent
            while current:
                if current.type in ("function_declaration", "method_definition", "function_expression"):
                    name_node = current.child_by_field_name("name")
                    if name_node:
                        return get_node_text(name_node)
                elif current.type == "variable_declarator":
                    name_node = current.child_by_field_name("name")
                    value_node = current.child_by_field_name("value")
                    if name_node and value_node and value_node.type == "arrow_function":
                        return get_node_text(name_node)
                current = current.parent
            return "<global>"

        def traverse(node: Node) -> None:
            node_type = node.type

            # 1. Functions & Methods
            if node_type in ("function_declaration", "generator_function_declaration", "method_definition"):
                name_node = node.child_by_field_name("name")
                func_name = get_node_text(name_node) if name_node else "<anonymous>"
                params_node = node.child_by_field_name("parameters")
                params = []
                if params_node:
                    for p in params_node.children:
                        if p.type in ("identifier", "formal_parameter", "required_parameter"):
                            p_name = p.child_by_field_name("name")
                            params.append(get_node_text(p_name) if p_name else get_node_text(p))

                return_type = None
                return_type_node = node.child_by_field_name("return_type")
                if return_type_node:
                    return_type = get_node_text(return_type_node).lstrip(": ").strip()

                functions.append(
                    FunctionFact(
                        name=func_name,
                        start_line=node.start_point[0] + 1,
                        end_line=node.end_point[0] + 1,
                        params=params,
                        return_type=return_type,
                    )
                )

            elif node_type == "variable_declarator":
                name_node = node.child_by_field_name("name")
                value_node = node.child_by_field_name("value")
                if name_node and value_node and value_node.type == "arrow_function":
                    func_name = get_node_text(name_node)
                    params_node = value_node.child_by_field_name("parameters")
                    params = []
                    if params_node:
                        for p in params_node.children:
                            if p.type in ("identifier", "formal_parameter", "required_parameter"):
                                p_name = p.child_by_field_name("name")
                                params.append(get_node_text(p_name) if p_name else get_node_text(p))

                    functions.append(
                        FunctionFact(
                            name=func_name,
                            start_line=node.start_point[0] + 1,
                            end_line=node.end_point[0] + 1,
                            params=params,
                            return_type=None,
                        )
                    )

            # 2. Classes
            elif node_type == "class_declaration":
                name_node = node.child_by_field_name("name")
                class_name = get_node_text(name_node) if name_node else "<anonymous>"
                heritage = []
                for child in node.children:
                    if child.type in ("class_heritage", "extends_clause"):
                        heritage_text = get_node_text(child).replace("extends", "").strip()
                        if heritage_text:
                            heritage.append(heritage_text)

                classes.append(
                    ClassFact(
                        name=class_name,
                        start_line=node.start_point[0] + 1,
                        end_line=node.end_point[0] + 1,
                        heritage=heritage,
                    )
                )

            # 3. Imports
            elif node_type == "import_statement":
                source_node = node.child_by_field_name("source")
                source_path = get_node_text(source_node).strip("'\"") if source_node else ""
                symbols = []

                for child in node.children:
                    if child.type == "import_clause":
                        symbols.append(get_node_text(child))

                imports.append(
                    ImportFact(
                        source_path=source_path,
                        imported_symbols=symbols,
                    )
                )

            # 4. Function Calls
            elif node_type == "call_expression":
                fn_node = node.child_by_field_name("function")
                if fn_node:
                    callee_name = get_node_text(fn_node)
                    caller_name = find_enclosing_function_name(node)
                    calls.append(
                        CallFact(
                            caller_name=caller_name,
                            callee_name=callee_name,
                            line_number=node.start_point[0] + 1,
                        )
                    )

            for child in node.children:
                traverse(child)

        traverse(root)

        return ParseResponse(
            file_path=file_path,
            language=language_id,
            functions=functions,
            classes=classes,
            imports=imports,
            calls=calls,
        )
    except Exception as e:
        logger.exception("Failed to parse file %s", file_path)
        return ParseResponse(
            file_path=file_path,
            language=language_id,
            error=f"Parsing exception: {str(e)}",
        )
