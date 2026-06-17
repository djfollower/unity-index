package com.github.dungphan.unityindex.exceptions

import com.github.dungphan.unityindex.server.models.JsonRpcErrorCodes

sealed class McpException(
    message: String,
    val errorCode: Int
) : Exception(message)

class ParseErrorException(message: String) :
    McpException(message, JsonRpcErrorCodes.PARSE_ERROR)

class InvalidRequestException(message: String) :
    McpException(message, JsonRpcErrorCodes.INVALID_REQUEST)

class MethodNotFoundException(method: String) :
    McpException("Method not found: $method", JsonRpcErrorCodes.METHOD_NOT_FOUND)

class InvalidParamsException(message: String) :
    McpException(message, JsonRpcErrorCodes.INVALID_PARAMS)

class InternalErrorException(message: String) :
    McpException(message, JsonRpcErrorCodes.INTERNAL_ERROR)

class IndexNotReadyException(message: String) :
    McpException(message, JsonRpcErrorCodes.INDEX_NOT_READY)

class FileNotFoundException(path: String) :
    McpException("File not found: $path", JsonRpcErrorCodes.FILE_NOT_FOUND)

class SymbolNotFoundException(message: String) :
    McpException(message, JsonRpcErrorCodes.SYMBOL_NOT_FOUND)

class RefactoringConflictException(message: String) :
    McpException(message, JsonRpcErrorCodes.REFACTORING_CONFLICT)
