- (void)dealloc
{
    if (self.pageFile.length > 0)
        [[NSFileManager defaultManager] removeItemAtPath:self.pageFile error:NULL];
    if (self.mermaidFile.length > 0)
        [[NSFileManager defaultManager] removeItemAtPath:self.mermaidFile error:NULL];
}

